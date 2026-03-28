import { useLocation } from 'react-router-dom';
import './Pay.scss';
import { useEffect, useState, useRef } from 'react';
import AppHelmet from '../AppHelmet';
import ScrollToTop from '../ScrollToTop';
import Loader from '../../components/Loader/Loader';
import { useNavigate } from 'react-router-dom';
import { pricings } from '../../data';
import { useRecoilState, useSetRecoilState } from 'recoil';
import { notificationState, subscriptionState, userState } from '../../recoil/atoms';
import { getUser, updateUser } from '../../firebase';
import Swal from 'sweetalert2';

// Twitter Events Utility Functions
const trackTwitterEvent = (eventId, parameters = {}) => {
  if (typeof window !== 'undefined' && window.twq) {
    window.twq('event', eventId, parameters);
  } else {
    console.warn('X Twitter pixel not loaded yet');
    if (typeof window !== 'undefined') {
      window.twitterEventQueue = window.twitterEventQueue || [];
      window.twitterEventQueue.push({ eventId, parameters });
    }
  }
};

const trackPurchase = (value, currency = 'KES', contents = []) => {
  trackTwitterEvent('tw-ql57w-ql57x', {
    value: value,
    currency: currency,
    contents: contents,
    conversion_id: 'goal-kings-subscription'
  });
};

// Twitter Pixel Queue Hook
const useTwitterPixelQueue = () => {
  useEffect(() => {
    const processQueue = () => {
      if (window.twitterEventQueue && window.twitterEventQueue.length > 0) {
        window.twitterEventQueue.forEach(({ eventId, parameters }) => {
          if (window.twq) {
            window.twq('event', eventId, parameters);
          }
        });
        window.twitterEventQueue = [];
      }
    };

    const interval = setInterval(() => {
      if (window.twq) {
        processQueue();
        clearInterval(interval);
      }
    }, 100);

    setTimeout(() => {
      clearInterval(interval);
    }, 10000);

    return () => clearInterval(interval);
  }, []);
};

export default function Subscription() {
  const [user, setUser] = useRecoilState(userState);
  const [loading, setLoading] = useState(false);
  const [isProcessing, setIsProcessing] = useState(false);
  const location = useLocation();
  const [data, setData] = useState(null);
  const setNotification = useSetRecoilState(notificationState);
  const [subscription, setSubscription] = useRecoilState(subscriptionState);
  const navigate = useNavigate();
  const wsRef = useRef(null);
  const currentCheckoutIdRef = useRef(null);
  const statusCheckIntervalRef = useRef(null);

  // HashBack API Configuration
  const HASHBACK_API_URL = 'https://hash-back-server-production.up.railway.app';

  // Initialize Twitter pixel queue
  useTwitterPixelQueue();

  useEffect(() => {
    if (location.state) {
      setData(location.state.subscription);
      setSubscription(location.state.subscription);
    } else {
      setData(pricings[0]);
      setSubscription(pricings[0]);
    }

    // Setup WebSocket connection for real-time payment confirmation
    setupWebSocket();

    return () => {
      if (wsRef.current) {
        wsRef.current.close();
      }
      if (statusCheckIntervalRef.current) {
        clearInterval(statusCheckIntervalRef.current);
      }
    };
  }, [location]);

  const setupWebSocket = () => {
    try {
      wsRef.current = new WebSocket('wss://hash-back-server-production.up.railway.app');
      
      wsRef.current.onopen = () => {
        console.log('WebSocket connected for subscription payment');
      };
      
      wsRef.current.onmessage = (event) => {
        try {
          const message = JSON.parse(event.data);
          console.log('WebSocket message:', message);
          
          if (message.type === 'payment_completed') {
            handlePaymentSuccess(message.data);
          }
        } catch (error) {
          console.error('Error parsing WebSocket message:', error);
        }
      };
      
      wsRef.current.onerror = (error) => {
        console.error('WebSocket error:', error);
      };
      
      wsRef.current.onclose = () => {
        console.log('WebSocket disconnected');
        setTimeout(setupWebSocket, 5000);
      };
    } catch (error) {
      console.log('WebSocket not supported, using polling fallback');
    }
  };

  const formatPhoneNumberForHashBack = (phone) => {
    let p = phone.toString().replace(/\D/g, "");
    
    if (p.startsWith("0")) {
      return p;
    }
    if (p.startsWith("7") || p.startsWith("1")) {
      return "0" + p;
    }
    if (p.startsWith("254")) {
      return "0" + p.substring(3);
    }
    return p;
  };

  const handlePaymentSuccess = (data) => {
    setIsProcessing(false);
    
    if (statusCheckIntervalRef.current) {
      clearInterval(statusCheckIntervalRef.current);
    }
    
    // Track successful payment
    trackPurchase(
      subscription.price,
      'KES',
      [
        {
          id: subscription.plan,
          quantity: 1,
          item_price: subscription.price
        }
      ]
    );
    
    Swal.fire({
      title: "Payment Successful! 🎉",
      html: `
        <div style="text-align: center;">
          <i class="fas fa-check-circle" style="font-size: 48px; color: #10b981;"></i>
          <h3 style="margin: 15px 0;">KSh ${data.amount || subscription.price} Paid</h3>
          <p>Your subscription payment was successful!</p>
          <p style="font-size: 0.85rem; color: #666; margin-top: 10px;">
            Transaction ID: ${data.transactionId || data.TransactionID || 'N/A'}
          </p>
        </div>
      `,
      icon: "success",
      confirmButtonText: "Activate Subscription",
      confirmButtonColor: "#059669"
    }).then(() => {
      // Activate subscription after successful payment
      handleUpgrade();
    });
  };

  const checkPaymentStatus = async (checkoutId) => {
    try {
      const response = await fetch(`${HASHBACK_API_URL}/api/check-payment-status`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ checkoutId })
      });
      
      const data = await response.json();
      console.log('Status check:', data);
      
      if (data.status === 'completed') {
        if (statusCheckIntervalRef.current) {
          clearInterval(statusCheckIntervalRef.current);
        }
        handlePaymentSuccess(data);
      } else if (data.status === 'failed') {
        if (statusCheckIntervalRef.current) {
          clearInterval(statusCheckIntervalRef.current);
        }
        Swal.close();
        Swal.fire({
          title: "Payment Failed",
          text: "The payment was not successful. Please try again.",
          icon: "error"
        });
        setIsProcessing(false);
      }
    } catch (error) {
      console.error('Status check error:', error);
    }
  };

  const handleUpgrade = async () => {
    setLoading(true);
    const currentDate = new Date().toISOString();
    await updateUser(user.email, true, {
      subDate: currentDate,
      billing: subscription.billing,
      plan: subscription.plan,
    }, setNotification).then(() => {
      getUser(user.email, setUser);
    }).then(() => {
      setLoading(false);
      navigate("/", { replace: true });
    }).catch((error) => {
      setLoading(false);
      console.error('Upgrade error:', error);
      Swal.fire({
        title: "Activation Failed",
        text: "Payment was successful but subscription activation failed. Please contact support.",
        icon: "error"
      });
    });
  };

  const initiateHashBackPayment = async () => {
    setIsProcessing(true);
    
    // Show loading
    Swal.fire({
      title: "Initiating Payment",
      text: "Connecting to M-Pesa...",
      allowOutsideClick: false,
      didOpen: () => {
        Swal.showLoading();
      }
    });
    
    try {
      const reference = `SUB-${subscription.plan}-${Date.now()}-${Math.floor(Math.random() * 10000)}`;
      const phoneNumber = user?.phone || "0712345678";
      const formattedPhone = formatPhoneNumberForHashBack(phoneNumber);
      
      const response = await fetch(`${HASHBACK_API_URL}/api/initiate-payment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          amount: subscription.price,
          phone: formattedPhone,
          reference: reference,
          userId: user?.email || 'anonymous',
          metadata: {
            plan: subscription.plan,
            billing: subscription.billing,
            type: 'subscription'
          }
        })
      });
      
      const data = await response.json();
      console.log('Initiation response:', data);
      
      if (data.success && data.checkoutId) {
        currentCheckoutIdRef.current = data.checkoutId;
        
        // Register with WebSocket if available
        if (wsRef.current && wsRef.current.readyState === WebSocket.OPEN) {
          wsRef.current.send(JSON.stringify({
            type: 'register',
            checkoutId: data.checkoutId
          }));
        }
        
        Swal.close();
        
        // Show M-Pesa prompt
        Swal.fire({
          title: "Check Your Phone",
          html: `
            <div style="text-align: center;">
              <i class="fas fa-mobile-alt" style="font-size: 48px; color: #065f46;"></i>
              <h3 style="margin: 15px 0;">Enter M-Pesa PIN</h3>
              <p>Check your phone to authorize payment of <strong>KSh ${subscription.price}</strong></p>
              <p style="margin-top: 10px;"><small>Phone: ${formattedPhone}</small></p>
              <div style="background: #f8f9ff; padding: 12px; border-radius: 8px; margin-top: 15px;">
                <p style="font-size: 0.8rem; margin: 0; color: #666;">
                  Reference: ${reference}
                </p>
              </div>
              <p style="font-size: 0.8rem; color: #059669; margin-top: 10px;">
                <i class="fas fa-clock"></i> You have 2 minutes to complete the payment
              </p>
            </div>
          `,
          icon: "info",
          confirmButtonText: "I've Completed Payment",
          showCancelButton: true,
          cancelButtonText: "Cancel",
        }).then((result) => {
          if (result.isConfirmed) {
            Swal.fire({
              title: "Waiting for Confirmation",
              html: `
                <div style="text-align: center;">
                  <div class="spinner-border text-success" role="status" style="width: 48px; height: 48px;">
                    <span class="visually-hidden">Loading...</span>
                  </div>
                  <p style="margin-top: 15px;">Please wait while we confirm your payment...</p>
                  <p style="font-size: 0.85rem; color: #666;">This will take a few moments</p>
                </div>
              `,
              allowOutsideClick: false,
              didOpen: () => {
                Swal.showLoading();
              }
            });
            
            // Start polling for payment status
            statusCheckIntervalRef.current = setInterval(() => {
              if (currentCheckoutIdRef.current) {
                checkPaymentStatus(currentCheckoutIdRef.current);
              }
            }, 5000);
            
            // Set timeout for payment confirmation (2 minutes)
            setTimeout(() => {
              if (statusCheckIntervalRef.current) {
                clearInterval(statusCheckIntervalRef.current);
                Swal.close();
                Swal.fire({
                  title: "Payment Not Confirmed",
                  text: "Payment confirmation timed out. Please check your M-Pesa statement or contact support.",
                  icon: "warning",
                  confirmButtonColor: "#059669"
                });
                setIsProcessing(false);
              }
            }, 120000);
          } else {
            setIsProcessing(false);
            Swal.fire({
              title: "Payment Cancelled",
              text: "You can complete the payment from your M-Pesa app or try again.",
              icon: "info"
            });
          }
        });
      } else {
        throw new Error(data.error || data.message || "Initiation failed");
      }
    } catch (error) {
      console.error('Payment error:', error);
      Swal.fire({
        title: "Payment Failed",
        text: error.message || "Unable to initiate payment. Please try again.",
        icon: "error"
      });
      setIsProcessing(false);
    }
  };

  const handlePayment = () => {
    if (!user?.phone) {
      Swal.fire({
        title: "Phone Number Required",
        text: "Please update your profile with your phone number to make M-Pesa payments.",
        icon: "warning",
        confirmButtonText: "Update Profile"
      }).then(() => {
        navigate("/profile");
      });
      return;
    }
    
    initiateHashBackPayment();
  };

  // Track when user lands on subscription page
  useEffect(() => {
    if (data) {
      trackTwitterEvent('tw-ql57w-ql57x', {
        value: data.price,
        currency: 'KES',
        contents: [
          {
            id: data.plan,
            quantity: 1,
            item_price: data.price
          }
        ],
        event_type: 'subscription_page_view'
      });
    }
  }, [data]);

  return (
    <div className='pay'>
      <AppHelmet title={"Subscription Payment"} />
      <ScrollToTop />
      {
        loading && <Loader />
      }

      <div className="payment-container" style={{ maxWidth: '500px', margin: '0 auto', padding: '20px' }}>
        {data && (
          <>
            <h4 style={{ textAlign: 'center', marginBottom: '15px' }}>
              Payment Of KSH {data.price}
            </h4>
            <h4 style={{ textAlign: 'center', marginBottom: '30px', color: '#666' }}>
              You Are About To Claim {data.plan} Plan.
            </h4>
          </>
        )}
        
        <div style={{ 
          background: '#f8f9fa', 
          padding: '20px', 
          borderRadius: '12px', 
          marginBottom: '20px' 
        }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '10px' }}>
            <span>Plan:</span>
            <strong>{subscription.plan}</strong>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between', marginBottom: '10px' }}>
            <span>Billing:</span>
            <strong>{subscription.billing}</strong>
          </div>
          <div style={{ display: 'flex', justifyContent: 'space-between' }}>
            <span>Amount:</span>
            <strong style={{ color: '#059669' }}>KSh {subscription.price}</strong>
          </div>
        </div>
        
        <button
          onClick={handlePayment}
          disabled={isProcessing || loading}
          style={{
            width: '100%',
            padding: '15px',
            background: isProcessing ? '#9ca3af' : 'linear-gradient(135deg, #059669 0%, #047857 100%)',
            color: 'white',
            border: 'none',
            borderRadius: '12px',
            fontSize: '1rem',
            fontWeight: '600',
            cursor: (isProcessing || loading) ? 'not-allowed' : 'pointer',
            transition: 'transform 0.2s'
          }}
        >
          <i className={`fas ${isProcessing ? 'fa-spinner fa-spin' : 'fa-mobile-alt'}`} style={{ marginRight: '8px' }}></i>
          {isProcessing ? "Processing..." : "Pay with M-Pesa via HashBack"}
        </button>
        
        <div style={{ 
          marginTop: '20px', 
          textAlign: 'center', 
          fontSize: '0.85rem', 
          color: '#666' 
        }}>
          <i className="fas fa-lock" style={{ marginRight: '5px' }}></i>
          Secure payment powered by HashBack
        </div>
        
        {user?.phone && (
          <div style={{ 
            marginTop: '15px', 
            textAlign: 'center', 
            fontSize: '0.8rem', 
            color: '#059669' 
          }}>
            <i className="fas fa-phone-alt"></i> Payment will be sent to: {user.phone}
          </div>
        )}
      </div>
    </div>
  );
}
