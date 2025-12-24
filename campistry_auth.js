document.getElementById("begin-btn").onclick = async function () {

  const email = document.getElementById("auth-email").value.trim();
  const password = document.getElementById("auth-password").value.trim();
  const campName = document.getElementById("camp-name-input").value.trim();
  const status = document.getElementById("auth-status");

  if (!email || !password || !campName) {
    status.innerText = "All fields are required.";
    return;
  }

  let { data, error } = await supabase.auth.signInWithPassword({ email, password });

  if (error) {
    const signup = await supabase.auth.signUp({ email, password });
    data = signup.data;
  }

  const user = data?.user;
  if (!user) {
    status.innerText = "Login failed.";
    return;
  }

  await supabase.from("camps").upsert([{ name: campName, owner: user.id }]);

  document.getElementById("welcome-screen").style.display = "none";
  document.getElementById("main-app-container").style.display = "block";
};
