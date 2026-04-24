// auth.js - Common Authentication Logic for Frontend

const API_BASE_AUTH = window.location.hostname === 'localhost' || window.location.hostname === '127.0.0.1'
  ? 'http://localhost:5000'
  : 'https://vahaan-bridge-sdp0.onrender.com';

/**
 * Check if user is logged in
 */
function isAuthenticated() {
  return !!localStorage.getItem('auth_token');
}

/**
 * Enforce login on protected pages. Redirects to login if not authenticated.
 */
function enforceLogin() {
  if (!isAuthenticated()) {
    window.location.href = 'login.html';
  }
}

/**
 * Get logged-in user data
 */
function getUser() {
  const user = localStorage.getItem('auth_user');
  return user ? JSON.parse(user) : null;
}

/**
 * Log out user
 */
function logout() {
  localStorage.removeItem('auth_token');
  localStorage.removeItem('auth_user');
  window.location.href = 'login.html';
}

/**
 * Update the navigation bar based on auth state
 */
function updateNavbar() {
  const authNavItem = document.getElementById('auth-nav-item');
  if (!authNavItem) return; // If nav is not set up with this ID

  if (isAuthenticated()) {
    const user = getUser();
    authNavItem.innerHTML = `
      <span style="color: var(--muted); font-size: 0.88rem; font-weight: 500; margin-right: 15px;">
        Hi, ${user?.fullName?.split(' ')[0] || 'User'}
      </span>
      <button onclick="logout()" class="nav-cta" style="background: transparent; color: var(--pink) !important; border: 1px solid var(--pink); box-shadow: none;">Log Out</button>
    `;
  } else {
    authNavItem.innerHTML = `
      <a href="login.html" class="nav-cta" style="background: transparent; color: var(--text) !important; border: none; box-shadow: none;">Log In</a>
      <a href="register.html" class="nav-cta">Register</a>
    `;
  }
}

// Automatically update navbar on load if auth-nav-item is present
document.addEventListener('DOMContentLoaded', updateNavbar);
