document.getElementById("begin-btn").onclick = async function () {

  const email = document.getElementById("auth-email").value.trim();
  const password = document.getElementById("auth-password").value.trim();
  const campName = document.getElementById("camp-name-input").value.trim();
  const status = document.getElementById("auth-status");

  if (!email || !password || !campName) {
    status.innerText = "All fields are required.";
    return;
  }

  // Try signup FIRST (Supabase SaaS pattern)
  let { data, error } = await supabase.auth.signUp({ email, password });

  // If already exists, then login
  if (!data.user) {
    const login = await supabase.auth.signInWithPassword({ email, password });
    data = login.data;
  }

  const user = data?.user;
  if (!user) {
    status.innerText = "Authentication failed.";
    return;
  }

  // Ensure camp exists
  await supabase.from("camps").upsert([{ name: campName, owner: user.id }]);

  // Enter Campistry OS
  document.getElementById("welcome-screen").style.display = "none";
  document.getElementById("main-app-container").style.display = "block";
};
