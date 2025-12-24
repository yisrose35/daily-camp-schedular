// ============================================================================
// campistry_auth.js — FINAL SaaS AUTH ENGINE
// ============================================================================

let authMode = "login";

const emailEl = document.getElementById("auth-email");
const passEl = document.getElementById("auth-password");
const campEl = document.getElementById("camp-name-input");
const statusEl = document.getElementById("auth-status");
const beginBtn = document.getElementById("begin-btn");
const loginBtn = document.getElementById("mode-login");
const signupBtn = document.getElementById("mode-signup");

// Toggle modes
loginBtn.onclick = () => setMode("login");
signupBtn.onclick = () => setMode("signup");

function setMode(mode) {
  authMode = mode;
  loginBtn.classList.toggle("active", mode === "login");
  signupBtn.classList.toggle("active", mode === "signup");
  campEl.style.display = mode === "signup" ? "block" : "none";
  beginBtn.innerText = mode === "signup" ? "Create Campistry Account" : "Sign In";
}

// Default state
setMode("login");

// Main submit
beginBtn.onclick = async () => {
  const email = emailEl.value.trim();
  const password = passEl.value.trim();
  const campName = campEl.value.trim();

  if (!email || !password || (authMode === "signup" && !campName)) {
    statusEl.innerText = "Please complete all fields.";
    return;
  }

  let user;

  if (authMode === "signup") {
    const signup = await supabase.auth.signUp({ email, password });
    user = signup.data.user;
    if (user) {
      await supabase.from("camps").insert([{ name: campName, owner: user.id }]);
    }
  } else {
    const login = await supabase.auth.signInWithPassword({ email, password });
    user = login.data.user;
  }

  if (!user) {
    statusEl.innerText = "Authentication failed.";
    return;
  }

  document.getElementById("welcome-screen").style.display = "none";
  document.getElementById("main-app-container").style.display = "block";
};
