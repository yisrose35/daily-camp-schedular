// =================================================================
// daily_overrides.js
// This file creates the UI for the "Daily Overrides" tab.
// It allows disabling fields, bunks, or leagues for a specific day.
// =================================================================

(function() {
    'use strict';

    let container = null;
    let masterSettings = {};
    let currentOverrides = { fields: [], bunks: [], leagues: [] };

    /**
     * Main entry point. Called by index.html tab click or calendar.js date change.
     */
    function init() {
        container = document.getElementById("daily-overrides-content");
        if (!container) return; // Failsafe

        container.innerHTML = "<h2>Overrides for " + window.currentScheduleDate + "</h2>";

        // 1. Load Master "Setup" Data (from app1, leagues)
        masterSettings.global = window.loadGlobalSettings?.() || {};
        masterSettings.app1 = masterSettings.global.app1 || {};
        masterSettings.leaguesByName = masterSettings.global.leaguesByName || {};

        // 2. Load the overrides for the *current* day
        const dailyData = window.loadCurrentDailyData?.() || {};
        currentOverrides = dailyData.overrides || { fields: [], bunks: [], leagues: [] };

        // 3. Render the UI sections
        renderFieldsOverride();
        renderBunksOverride();
        renderLeaguesOverride();
    }

    /**
     * Renders the "Unavailable Fields & Specials" checklist
     */
    function renderFieldsOverride() {
        const wrapper = document.createElement('div');
        wrapper.className = 'override-section';
        wrapper.innerHTML = '<h3>Unavailable Fields & Specials</h3>';

        const allFields = (masterSettings.app1.fields || []).concat(masterSettings.app1.specialActivities || []);

        if (allFields.length === 0) {
            wrapper.innerHTML += '<p class="muted">No fields or special activities found in Setup.</p>';
            container.appendChild(wrapper);
            return;
        }

        allFields.forEach(item => {
            const el = createCheckbox(item.name, currentOverrides.fields.includes(item.name));
            el.checkbox.onchange = () => {
                if (el.checkbox.checked) {
                    if (!currentOverrides.fields.includes(item.name)) {
                        currentOverrides.fields.push(item.name);
                    }
                } else {
                    currentOverrides.fields = currentOverrides.fields.filter(f => f !== item.name);
                }
                // Save changes back to the current day
                window.saveCurrentDailyData("overrides", currentOverrides);
            };
            wrapper.appendChild(el.wrapper);
        });
        container.appendChild(wrapper);
    }

    /**
     * Renders the "Unavailable Bunks" checklist, grouped by division
     */
    function renderBunksOverride() {
        const wrapper = document.createElement('div');
        wrapper.className = 'override-section';
        wrapper.innerHTML = '<h3>Unavailable Bunks / Divisions</h3>';
        
        const divisions = masterSettings.app1.divisions || {};
        const availableDivisions = masterSettings.app1.availableDivisions || [];

        if (availableDivisions.length === 0) {
            wrapper.innerHTML += '<p class="muted">No divisions found in Setup.</p>';
            container.appendChild(wrapper);
            return;
        }

        availableDivisions.forEach(divName => {
            const div = divisions[divName];
            if (!div) return;

            const divHeader = document.createElement('h4');
            divHeader.textContent = divName;
            divHeader.style.color = div.color;
            divHeader.style.borderBottom = `2px solid ${div.color}`;
            divHeader.style.paddingBottom = '4px';
            wrapper.appendChild(divHeader);

            const bunkList = div.bunks || [];
            if (bunkList.length === 0) {
                wrapper.innerHTML += `<p class="muted" style="margin-left: 10px;">No bunks in ${divName}.</p>`;
            }

            bunkList.forEach(bunkName => {
                const el = createCheckbox(bunkName, currentOverrides.bunks.includes(bunkName));
                el.checkbox.onchange = () => {
                    if (el.checkbox.checked) {
                        if (!currentOverrides.bunks.includes(bunkName)) {
                            currentOverrides.bunks.push(bunkName);
                        }
                    } else {
                        currentOverrides.bunks = currentOverrides.bunks.filter(b => b !== bunkName);
                    }
                    window.saveCurrentDailyData("overrides", currentOverrides);
                };
                el.wrapper.style.marginLeft = '10px';
                wrapper.appendChild(el.wrapper);
            });
        });
        container.appendChild(wrapper);
    }

    /**
     * Renders the "Disabled Leagues" checklist
     */
    function renderLeaguesOverride() {
        const wrapper = document.createElement('div');
        wrapper.className = 'override-section';
        wrapper.innerHTML = '<h3>Disabled Leagues</h3>';

        const leagues = masterSettings.leaguesByName || {};
        const leagueNames = Object.keys(leagues);

        if (leagueNames.length === 0) {
            wrapper.innerHTML += '<p class="muted">No leagues found in Setup.</p>';
            container.appendChild(wrapper);
            return;
        }

        leagueNames.forEach(leagueName => {
            const el = createCheckbox(leagueName, currentOverrides.leagues.includes(leagueName));
            el.checkbox.onchange = () => {
                if (el.checkbox.checked) {
                    if (!currentOverrides.leagues.includes(leagueName)) {
                        currentOverrides.leagues.push(leagueName);
                    }
                } else {
                    currentOverrides.leagues = currentOverrides.leagues.filter(l => l !== leagueName);
                }
                window.saveCurrentDailyData("overrides", currentOverrides);
            };
            wrapper.appendChild(el.wrapper);
        });
        container.appendChild(wrapper);
    }

    /**
     * Helper to create a standardized checkbox UI element
     */
    function createCheckbox(name, isChecked) {
        const wrapper = document.createElement('label');
        wrapper.className = 'override-checkbox';
        
        const checkbox = document.createElement('input');
        checkbox.type = 'checkbox';
        checkbox.checked = isChecked;
        
        const text = document.createElement('span');
        text.textContent = name;
        
        wrapper.appendChild(checkbox);
        wrapper.appendChild(text);
        return { wrapper, checkbox };
    }

    // Expose the init function to the global window
    window.initDailyOverrides = init;

})();
