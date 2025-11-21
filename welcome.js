
// This script now controls the boot-up process for the entire application.
// UPDATED: Added Passcode Authentication Gate.

document.addEventListener("DOMContentLoaded", () => {
    // --- 1. Get DOM Elements ---
    const welcomeScreen = document.getElementById('welcome-screen');
    const mainAppContainer = document.getElementById('main-app-container');
    const campNameInput = document.getElementById('camp-name-input');
    const welcomeTitle = document.getElementById('welcome-title');
    const beginBtn = document.getElementById('begin-btn');
    const welcomeText = welcomeScreen.querySelector('p');

    // --- CONSTANTS ---
    const AUTH_KEY = "camp_scheduler_auth_v1";
    const PASSCODE = "campisawesome";

    // --- BOOT FUNCTION (Preserved) ---
    function bootMainApp() {
        console.log("Booting main application...");
        // 1. Init Calendar (loads date, save/load fns, migration)
        if (window.initCalendar) {
            window.initCalendar();
        } else {
            console.error("Fatal: calendar.js init not found.");
            return;
        }

        // 2. Init App1 (loads bunks, divisions)
        if (window.initApp1) {
            window.initApp1();
        } else {
            console.error("Fatal: app1.js init not found.");
            return;
        }

        // 3. Init Leagues (loads league data, renders tab)
        if (window.initLeagues) {
            window.initLeagues();
        } else {
            console.warn("Leagues.js init not found.");
        }

        // 4. Init Schedule System (loads today's schedule)
        if (window.initScheduleSystem) {
            window.initScheduleSystem();
        } else {
            console.warn("initScheduleSystem not found.");
        }
    }

    // --- APPLICATION FLOW LOGIC ---
    function runAppFlow() {
        // 1. Check for Saved Camp Name
        let app1Data = {};
        let campName = "";

        if (window.loadGlobalSettings) {
            const globalSettings = window.loadGlobalSettings();
            app1Data = globalSettings.app1 || {};
            campName = app1Data.campName || "";
        }

        if (campName) {
            // Camp name exists, just run the app
            welcomeScreen.style.display = 'none';
            mainAppContainer.style.display = 'block';
            bootMainApp();
        } else {
            // No camp name, show the Setup Screen
            setupCampNameUI(app1Data);
        }
    }

    function setupCampNameUI(app1Data) {
        welcomeScreen.style.display = 'flex';
        mainAppContainer.style.display = 'none';
        
        welcomeTitle.textContent = "Welcome to The Camp Scheduler";
        welcomeText.textContent = "Please enter your camp's name to get started.";
        
        campNameInput.style.display = 'block';
        campNameInput.type = 'text';
        campNameInput.placeholder = "E.g., Camp Adventure";
        campNameInput.value = ""; // Clear any previous input
        
        beginBtn.textContent = "Begin";
        
        // Remove old listeners by replacing the button node (cleanest way) is not strictly needed 
        // if we use onclick assignment which overrides previous handlers.
        beginBtn.onclick = () => {
            const newCampName = campNameInput.value.trim();

            if (newCampName === "") {
                alert("Please enter your camp's name.");
                return;
            }

            // Save the new camp name
            if (window.saveGlobalSettings) {
                app1Data.campName = newCampName;
                window.saveGlobalSettings('app1', app1Data);
            } else {
                console.error("Could not save camp name. saveGlobalSettings not found.");
                localStorage.setItem("temp_camp_name", newCampName);
            }

            // Hide welcome, show app
            welcomeScreen.style.display = 'none';
            mainAppContainer.style.display = 'block';

            // Now boot the main application
            bootMainApp();
        };

        // Allow Enter key
        campNameInput.onkeyup = (e) => {
            if (e.key === 'Enter') beginBtn.click();
        };
    }

    // --- AUTHENTICATION UI ---
    function setupAuthUI() {
        welcomeScreen.style.display = 'flex';
        mainAppContainer.style.display = 'none';

        welcomeTitle.textContent = "Camp Scheduler Locked";
        welcomeText.textContent = "This is a paid service. Please enter the passcode to continue.";
        
        campNameInput.style.display = 'block';
        campNameInput.type = 'password';
        campNameInput.placeholder = "Enter Passcode";
        campNameInput.value = "";
        
        beginBtn.textContent = "Unlock";

        beginBtn.onclick = () => {
            const enteredCode = campNameInput.value;
            if (enteredCode === PASSCODE) {
                localStorage.setItem(AUTH_KEY, "true");
                // Clear input and proceed
                campNameInput.value = "";
                runAppFlow();
            } else {
                alert("Incorrect passcode. Please try again.");
                campNameInput.value = "";
            }
        };

        // Allow Enter key
        campNameInput.onkeyup = (e) => {
            if (e.key === 'Enter') beginBtn.click();
        };
    }

    // --- MAIN ENTRY POINT ---
    const isAuthorized = localStorage.getItem(AUTH_KEY) === "true";

    if (isAuthorized) {
        runAppFlow();
    } else {
        setupAuthUI();
    }

});
