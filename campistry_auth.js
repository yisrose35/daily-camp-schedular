let authMode = "login";

document.getElementById("mode-login").onclick = () => setMode("login");
document.getElementById("mode-signup").onclick = () => setMode("signup");

function setMode(mode) {
  authMode = mode;
  document.getElementById("mode-login").classList.toggle("active", mode === "login");
  document.getElementById("mode-signup").classList.toggle("active", mode === "signup");
  document.getElementById("camp-name-input").style.display = mode === "signup" ? "block" : "none";
  document.getElementById("begin-btn").innerText = mode === "signup" ? "Create Campistry Account" : "Sign In";
}

document.getElementById("begin-btn").onclick = async () => {
  const email = auth-email.value.trim();
  const password = auth-password.value.trim();
  const campName = camp-name-input.value.trim();
  const status = auth-status;

  if (!email || !password || (authMode === "signup" && !campName)) {
    status.innerText = "Please complete all fields.";
    return;
  }

  let user;

  if (authMode === "signup") {
    const signup = await supabase.auth.signUp({ email, password });
    user = signup.data.user;
    await supabase.from("camps").insert([{ name: campName, owner: user.id }]);
  } else {
    const login = await supabase.auth.signInWithPassword({ email, password });
    user = login.data.user;
  }

  if (!user) {
    status.innerText = "Authentication failed.";
    return;
  }

  document.getElementById("welcome-screen").style.display = "none";
  document.getElementById("main-app-container").style.display = "block";
};
