/**
 * Token Storage
 */
function storeTokens(tokens) {
  sessionStorage.setItem('idToken', tokens.idToken);
  sessionStorage.setItem('accessToken', tokens.accessToken);
  sessionStorage.setItem('refreshToken', tokens.refreshToken);
}

function retrieveTokens() {
  var idToken = sessionStorage.getItem('idToken');
  var accessToken = sessionStorage.getItem('accessToken');
  var refreshToken = sessionStorage.getItem('refreshToken');
  if (!idToken || !accessToken || !refreshToken) return null;
  return { idToken: idToken, accessToken: accessToken, refreshToken: refreshToken };
}

function clearTokens() {
  sessionStorage.removeItem('idToken');
  sessionStorage.removeItem('accessToken');
  sessionStorage.removeItem('refreshToken');
}

/**
 * JWT Parsing
 */
function extractUsernameFromToken(idToken) {
  var parts = idToken.split('.');
  if (parts.length !== 3) throw new Error('Invalid token format');
  var base64 = parts[1].replace(/-/g, '+').replace(/_/g, '/');
  var padded = base64 + '='.repeat((4 - base64.length % 4) % 4);
  var decoded = decodeURIComponent(escape(atob(padded)));
  var claims = JSON.parse(decoded);
  return claims['cognito:username'] || claims['email'] || 'User';
}

/**
 * Login
 */
var pendingPasswordChange = null;

async function login(username, password) {
  if (!username || !password) throw new Error('Username and password are required');

  var cfg = window.cognitoConfig;
  if (!cfg || !cfg.userPoolId || !cfg.clientId) throw new Error('Cognito configuration not found');
  if (typeof AmazonCognitoIdentity === 'undefined') throw new Error('Cognito SDK not loaded');

  var authDetails = new AmazonCognitoIdentity.AuthenticationDetails({
    Username: username.trim(),
    Password: password,
  });

  var userPool = new AmazonCognitoIdentity.CognitoUserPool({
    UserPoolId: cfg.userPoolId,
    ClientId: cfg.clientId,
  });

  var cognitoUser = new AmazonCognitoIdentity.CognitoUser({
    Username: username.trim(),
    Pool: userPool,
  });

  return new Promise(function(resolve, reject) {
    cognitoUser.authenticateUser(authDetails, {
      onSuccess: function(result) {
        storeTokens({
          idToken: result.getIdToken().getJwtToken(),
          accessToken: result.getAccessToken().getJwtToken(),
          refreshToken: result.getRefreshToken().getToken(),
        });
        displayAuthenticatedUI(extractUsernameFromToken(result.getIdToken().getJwtToken()));
        resolve();
      },
      onFailure: function(err) {
        var msg = 'Invalid credentials';
        if (err.code === 'UserNotConfirmedException') msg = 'Account not confirmed';
        else if (err.code === 'PasswordResetRequiredException') msg = 'Password reset required';
        else if (err.code === 'TooManyRequestsException') msg = 'Too many attempts. Try later';
        reject(new Error(msg));
      },
      newPasswordRequired: function(userAttributes) {
        pendingPasswordChange = { cognitoUser: cognitoUser, userAttributes: userAttributes };
        displayPasswordChangeUI();
        resolve();
      },
    });
  });
}

async function completeNewPassword(newPassword) {
  if (!pendingPasswordChange) throw new Error('No pending password change');
  if (!newPassword) throw new Error('New password is required');

  var cognitoUser = pendingPasswordChange.cognitoUser;
  var userAttributes = pendingPasswordChange.userAttributes;
  var filtered = {};
  for (var key in userAttributes) {
    if (['email_verified', 'phone_number_verified', 'email', 'phone_number'].indexOf(key) === -1) {
      filtered[key] = userAttributes[key];
    }
  }

  return new Promise(function(resolve, reject) {
    cognitoUser.completeNewPasswordChallenge(newPassword, filtered, {
      onSuccess: function(result) {
        storeTokens({
          idToken: result.getIdToken().getJwtToken(),
          accessToken: result.getAccessToken().getJwtToken(),
          refreshToken: result.getRefreshToken().getToken(),
        });
        pendingPasswordChange = null;
        displayAuthenticatedUI(extractUsernameFromToken(result.getIdToken().getJwtToken()));
        resolve();
      },
      onFailure: function(err) {
        reject(new Error(err.message || 'Failed to change password'));
      },
    });
  });
}

/**
 * UI State Management
 */
function displayLoginUI() {
  document.getElementById('login-form').style.display = 'block';
  document.getElementById('password-change-form').style.display = 'none';
  document.getElementById('authenticated-content').style.display = 'none';
}

function displayPasswordChangeUI() {
  document.getElementById('login-form').style.display = 'none';
  document.getElementById('password-change-form').style.display = 'block';
  document.getElementById('authenticated-content').style.display = 'none';
}

function displayAuthenticatedUI(username) {
  document.getElementById('login-form').style.display = 'none';
  document.getElementById('password-change-form').style.display = 'none';
  document.getElementById('authenticated-content').style.display = 'flex';
  document.getElementById('username-display').textContent = username;
  initializeConnectWidget();
}

function checkAuthState() {
  var tokens = retrieveTokens();
  if (tokens && tokens.idToken) {
    try {
      displayAuthenticatedUI(extractUsernameFromToken(tokens.idToken));
    } catch (e) {
      clearTokens();
      displayLoginUI();
    }
  } else {
    displayLoginUI();
  }
}

function logout() {
  clearTokens();
  hideConnectWidget();
  displayLoginUI();
}

/**
 * Connect Widget — loads the first configured widget by default
 */
function initializeConnectWidget() {
  if (window.connectWidgetInitialized) {
    showConnectWidget();
    return;
  }

  var cfg = window.cognitoConfig;
  if (!cfg || !cfg.widgets || cfg.widgets.length === 0) {
    console.error('No Connect widgets configured in config.js');
    return;
  }

  // Use the first widget by default
  var widget = cfg.widgets[0];

  window.amazon_connect = window.amazon_connect || function() {
    (window.amazon_connect.ac = window.amazon_connect.ac || []).push(arguments);
  };

  amazon_connect('styles', {
    iconType: 'VOICE',
    openChat: { color: '#ffffff', backgroundColor: '#123456' },
    closeChat: { color: '#ffffff', backgroundColor: '#123456' },
  });
  amazon_connect('snippetId', widget.snippetId);
  amazon_connect('supportedMessagingContentTypes', [
    'text/plain',
    'text/markdown',
    'application/vnd.amazonaws.connect.message.interactive',
    'application/vnd.amazonaws.connect.message.interactive.response',
  ]);

  // JWT Authentication callback — passes widgetId to the token endpoint
  amazon_connect('authenticate', function(callback) {
    var idToken = sessionStorage.getItem('idToken');
    if (!idToken) {
      console.error('No auth token found');
      callback(null);
      return;
    }

    fetch('/api/token?widgetId=' + encodeURIComponent(widget.id), {
      method: 'GET',
      headers: { 'Authorization': idToken, 'Content-Type': 'application/json' },
    })
      .then(function(res) {
        if (!res.ok) {
          console.error('Token fetch failed:', res.status);
          callback(null);
          return;
        }
        return res.json();
      })
      .then(function(data) {
        if (data && data.token) callback(data.token);
        else callback(null);
      })
      .catch(function(err) {
        console.error('Token fetch error:', err);
        callback(null);
      });
  });

  // Load the Connect widget script
  var script = document.createElement('script');
  script.src = widget.scriptUrl;
  script.async = true;
  script.id = widget.id;
  script.onload = function() { window.connectWidgetInitialized = true; };
  script.onerror = function() { console.error('Failed to load Connect widget script'); };
  document.head.appendChild(script);
}

function showConnectWidget() {
  document.querySelectorAll('[id^="amazon-connect-chat-widget"]').forEach(function(el) {
    el.style.display = 'block';
  });
}

function hideConnectWidget() {
  document.querySelectorAll('[id^="amazon-connect-chat-widget"]').forEach(function(el) {
    el.style.display = 'none';
  });
}

/**
 * Event Listeners
 */
window.addEventListener('DOMContentLoaded', function() {
  checkAuthState();

  // Login form
  document.getElementById('login-form-element').addEventListener('submit', async function(e) {
    e.preventDefault();
    var username = document.getElementById('username').value;
    var password = document.getElementById('password').value;
    var errorEl = document.getElementById('error-message');
    var btn = document.getElementById('login-button');

    errorEl.style.display = 'none';
    btn.disabled = true;
    btn.textContent = 'Logging in...';

    try {
      await login(username, password);
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.style.display = 'block';
    } finally {
      btn.disabled = false;
      btn.textContent = 'Login';
    }
  });

  // Password change form
  document.getElementById('password-change-form-element').addEventListener('submit', async function(e) {
    e.preventDefault();
    var newPw = document.getElementById('new-password').value;
    var confirmPw = document.getElementById('confirm-password').value;
    var errorEl = document.getElementById('password-change-error');
    var btn = document.getElementById('change-password-button');

    errorEl.style.display = 'none';

    if (newPw !== confirmPw) {
      errorEl.textContent = 'Passwords do not match';
      errorEl.style.display = 'block';
      return;
    }

    btn.disabled = true;
    btn.textContent = 'Changing Password...';

    try {
      await completeNewPassword(newPw);
    } catch (err) {
      errorEl.textContent = err.message;
      errorEl.style.display = 'block';
    } finally {
      btn.disabled = false;
      btn.textContent = 'Change Password';
    }
  });

  // Logout
  document.getElementById('logout-button').addEventListener('click', logout);
});
