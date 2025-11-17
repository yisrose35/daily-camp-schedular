
// This script now controls the boot-up process for the entire application.

document.addEventListener("DOMContentLoaded", () => {
    // --- 1. Get DOM Elements ---
    const welcomeScreen = document.getElementById('welcome-screen');
    const mainAppContainer = document.getElementById('main-app-container');
    const campNameInput = document.getElementById('camp-name-input');
    const welcomeTitle = document.getElementById('welcome-title');
    const beginBtn = document.getElementById('begin-btn');

    // This is the main boot function, moved from index.html
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

    // --- 2. Check for Saved Camp Name ---
    let app1Data = {};
    let campName = "";

    if (window.loadGlobalSettings) {
        const globalSettings = window.loadGlobalSettings();
        app1Data = globalSettings.app1 || {};
        campName = app1Data.campName || "";
    }

    if (campName) {
        // Camp name exists, just run the app
        mainAppContainer.style.display = 'block';
        bootMainApp();
    } else {
        // No camp name, show the welcome screen
        welcomeScreen.style.display = 'flex';
    }

    // --- 3. Add Listener for the Begin Button ---
    beginBtn.addEventListener('click', () => {
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
            // Fallback to localStorage just in case
            localStorage.setItem("temp_camp_name", newCampName);
        }

        // Hide welcome, show app
        welcomeScreen.style.display = 'none';
        mainAppContainer.style.display = 'block';

        // Now boot the main application
        bootMainApp();
    });

    // --- 4. Add listener for input (optional: save on edit) ---
    // This part is for an existing camp name, allowing it to be edited.
    // We can add an "Edit" button next to the camp name in the main app later.
    // For now, this logic is complete for the welcome screen.

});
