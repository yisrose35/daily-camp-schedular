// ============================================================================
// division_selector.js — Division Selection for Generation
// ============================================================================
// Adds division checkboxes to the Generate button flow
// Respects access control - only shows divisions user can generate
// Persists field locks between generation runs
// ============================================================================

(function() {
    'use strict';

    console.log("☑️ Division Selector v1.0 loading...");

    // =========================================================================
    // STATE
    // =========================================================================

    let _selectedDivisions = new Set();
    let _generatedDivisions = new Set(); // Already generated (from field locks)
    let _existingLocks = {};
    let _currentDate = null;

    // =========================================================================
    // INITIALIZATION
    // =========================================================================

    async function initialize(date) {
        _currentDate = date || new Date().toISOString().split('T')[0];
        
        // Load existing field locks for this date
        if (window.AccessControl) {
            const { locks, generatedDivisions } = await window.AccessControl.loadFieldLocks(_currentDate);
            _existingLocks = locks || {};
            _generatedDivisions = new Set(generatedDivisions || []);
        }

        console.log("☑️ Division selector initialized:", {
            date: _currentDate,
            existingLocks: Object.keys(_existingLocks).length,
            alreadyGenerated: [..._generatedDivisions]
        });
    }

    // =========================================================================
    // RENDER DIVISION SELECTOR
    // =========================================================================

    /**
     * Create the division selector modal/dropdown
     * Called when user clicks Generate button
     */
    function renderDivisionSelector(onConfirm, onCancel) {
        // Get all divisions
        const allDivisions = Object.keys(window.divisions || {});
        
        // Get editable divisions (based on access control)
        const editableDivisions = window.AccessControl?.getEditableDivisions() || allDivisions;
        
        // Create modal
        const modal = document.createElement('div');
        modal.id = 'division-selector-modal';
        modal.className = 'division-selector-modal';
        modal.innerHTML = `
            <div class="division-selector-content">
                <div class="division-selector-header">
                    <h3>Generate Schedule</h3>
                    <button class="modal-close" id="division-selector-close">&times;</button>
                </div>
                
                <p style="color: var(--slate-600); margin-bottom: 16px; font-size: 0.9rem;">
                    Select which divisions to generate. Previously generated divisions will keep their field assignments.
                </p>
                
                ${_generatedDivisions.size > 0 ? `
                    <div class="already-generated-notice">
                        <span style="font-size: 1.1rem;">🔒</span>
                        <div>
                            <strong>Already generated:</strong>
                            <span>${[..._generatedDivisions].join(', ')}</span>
                        </div>
                    </div>
                ` : ''}
                
                <div class="division-selector-grid">
                    ${allDivisions.map(div => {
                        const isEditable = editableDivisions.includes(div);
                        const isGenerated = _generatedDivisions.has(div);
                        const subdivision = window.AccessControl?.getSubdivisionForDivision(div);
                        
                        return `
                            <label class="division-checkbox ${!isEditable ? 'disabled' : ''} ${isGenerated ? 'generated' : ''}">
                                <input 
                                    type="checkbox" 
                                    name="division" 
                                    value="${div}"
                                    ${!isEditable ? 'disabled' : ''}
                                    ${isGenerated ? 'disabled' : ''}
                                >
                                <div class="division-checkbox-content">
                                    <span class="division-name">${div}</span>
                                    ${subdivision ? `
                                        <span class="division-subdivision" style="background: ${subdivision.color}20; color: ${subdivision.color};">
                                            ${subdivision.name}
                                        </span>
                                    ` : ''}
                                    ${isGenerated ? '<span class="division-status">✓ Generated</span>' : ''}
                                    ${!isEditable && !isGenerated ? '<span class="division-status">🔒 No access</span>' : ''}
                                </div>
                            </label>
                        `;
                    }).join('')}
                </div>
                
                <div class="division-selector-actions">
                    <button class="btn-ghost" id="division-selector-select-all">Select All Available</button>
                    <button class="btn-ghost" id="division-selector-clear">Clear</button>
                </div>
                
                <div class="division-selector-footer">
                    <button class="btn-secondary" id="division-selector-cancel">Cancel</button>
                    <button class="btn-primary" id="division-selector-confirm">
                        Generate Selected
                    </button>
                </div>
                
                <div class="division-selector-advanced">
                    <details>
                        <summary>Advanced Options</summary>
                        <div style="padding: 12px 0;">
                            <label class="checkbox-item" style="margin-bottom: 8px;">
                                <input type="checkbox" id="clear-existing-locks">
                                <span>Clear existing field locks and regenerate everything</span>
                            </label>
                            <p style="font-size: 0.8rem; color: var(--slate-500); margin: 0;">
                                This will remove all previous field assignments and start fresh.
                            </p>
                        </div>
                    </details>
                </div>
            </div>
        `;

        document.body.appendChild(modal);

        // Bind events
        document.getElementById('division-selector-close').onclick = () => {
            modal.remove();
            if (onCancel) onCancel();
        };

        document.getElementById('division-selector-cancel').onclick = () => {
            modal.remove();
            if (onCancel) onCancel();
        };

        document.getElementById('division-selector-select-all').onclick = () => {
            modal.querySelectorAll('input[name="division"]:not(:disabled)').forEach(cb => {
                cb.checked = true;
            });
            updateConfirmButton();
        };

        document.getElementById('division-selector-clear').onclick = () => {
            modal.querySelectorAll('input[name="division"]').forEach(cb => {
                cb.checked = false;
            });
            updateConfirmButton();
        };

        document.getElementById('division-selector-confirm').onclick = () => {
            const selected = [];
            modal.querySelectorAll('input[name="division"]:checked').forEach(cb => {
                selected.push(cb.value);
            });

            if (selected.length === 0) {
                alert('Please select at least one division to generate.');
                return;
            }

            const clearExisting = document.getElementById('clear-existing-locks')?.checked || false;

            modal.remove();
            
            if (onConfirm) {
                onConfirm({
                    divisions: selected,
                    clearExisting: clearExisting,
                    existingLocks: clearExisting ? {} : _existingLocks,
                    previouslyGenerated: clearExisting ? [] : [..._generatedDivisions]
                });
            }
        };

        // Update button state on checkbox change
        modal.querySelectorAll('input[name="division"]').forEach(cb => {
            cb.onchange = updateConfirmButton;
        });

        function updateConfirmButton() {
            const count = modal.querySelectorAll('input[name="division"]:checked').length;
            const btn = document.getElementById('division-selector-confirm');
            btn.textContent = count > 0 ? `Generate ${count} Division${count > 1 ? 's' : ''}` : 'Generate Selected';
            btn.disabled = count === 0;
        }

        // Click outside to close
        modal.onclick = (e) => {
            if (e.target === modal) {
                modal.remove();
                if (onCancel) onCancel();
            }
        };

        return modal;
    }

    // =========================================================================
    // FIELD LOCKS MANAGEMENT
    // =========================================================================

    /**
     * Merge new locks with existing locks
     */
    function mergeLocks(existingLocks, newLocks) {
        const merged = { ...existingLocks };
        
        for (const [key, value] of Object.entries(newLocks)) {
            if (!merged[key]) {
                merged[key] = value;
            } else {
                // Merge arrays (time slots)
                merged[key] = [...new Set([...merged[key], ...value])];
            }
        }
        
        return merged;
    }

    /**
     * Save locks after generation
     */
    async function saveLocks(newLocks, newGeneratedDivisions) {
        // Merge with existing
        const mergedLocks = mergeLocks(_existingLocks, newLocks);
        const allGenerated = [...new Set([..._generatedDivisions, ...newGeneratedDivisions])];
        
        // Save to database
        if (window.AccessControl) {
            await window.AccessControl.saveFieldLocks(_currentDate, mergedLocks, allGenerated);
        }
        
        // Update local state
        _existingLocks = mergedLocks;
        _generatedDivisions = new Set(allGenerated);
        
        console.log("☑️ Locks saved:", {
            totalLocks: Object.keys(mergedLocks).length,
            generatedDivisions: allGenerated
        });
    }

    /**
     * Get existing locks for scheduler to respect
     */
    function getExistingLocks() {
        return { ..._existingLocks };
    }

    /**
     * Get already-generated divisions
     */
    function getGeneratedDivisions() {
        return [..._generatedDivisions];
    }

    /**
     * Clear all locks for current date
     */
    async function clearAllLocks() {
        if (window.AccessControl) {
            await window.AccessControl.clearFieldLocks(_currentDate);
        }
        _existingLocks = {};
        _generatedDivisions = new Set();
        
        console.log("☑️ All locks cleared for", _currentDate);
    }

    // =========================================================================
    // CSS STYLES
    // =========================================================================

    function injectStyles() {
        if (document.getElementById('division-selector-styles')) return;

        const styles = document.createElement('style');
        styles.id = 'division-selector-styles';
        styles.textContent = `
            .division-selector-modal {
                position: fixed;
                top: 0;
                left: 0;
                right: 0;
                bottom: 0;
                background: rgba(0, 0, 0, 0.5);
                display: flex;
                align-items: center;
                justify-content: center;
                z-index: 10000;
                animation: fadeIn 0.15s ease-out;
            }
            
            @keyframes fadeIn {
                from { opacity: 0; }
                to { opacity: 1; }
            }
            
            .division-selector-content {
                background: white;
                border-radius: 16px;
                padding: 24px;
                max-width: 600px;
                width: 90%;
                max-height: 85vh;
                overflow-y: auto;
                box-shadow: 0 20px 40px rgba(0, 0, 0, 0.25);
                animation: slideUp 0.2s ease-out;
            }
            
            @keyframes slideUp {
                from { transform: translateY(20px); opacity: 0; }
                to { transform: translateY(0); opacity: 1; }
            }
            
            .division-selector-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 16px;
            }
            
            .division-selector-header h3 {
                margin: 0;
                font-size: 1.3rem;
                color: var(--slate-900);
            }
            
            .already-generated-notice {
                display: flex;
                align-items: center;
                gap: 12px;
                padding: 12px 16px;
                background: #DBEAFE;
                border: 1px solid #93C5FD;
                border-radius: 10px;
                margin-bottom: 16px;
                font-size: 0.9rem;
                color: #1E40AF;
            }
            
            .division-selector-grid {
                display: grid;
                grid-template-columns: repeat(auto-fill, minmax(180px, 1fr));
                gap: 10px;
                margin-bottom: 16px;
                max-height: 300px;
                overflow-y: auto;
                padding: 4px;
            }
            
            .division-checkbox {
                display: flex;
                align-items: flex-start;
                gap: 10px;
                padding: 12px;
                background: var(--slate-50);
                border: 2px solid transparent;
                border-radius: 10px;
                cursor: pointer;
                transition: all 0.15s ease;
            }
            
            .division-checkbox:hover:not(.disabled) {
                background: var(--slate-100);
                border-color: var(--slate-200);
            }
            
            .division-checkbox:has(input:checked) {
                background: #EEF2FF;
                border-color: #6366F1;
            }
            
            .division-checkbox.disabled {
                opacity: 0.6;
                cursor: not-allowed;
            }
            
            .division-checkbox.generated {
                background: #F0FDF4;
                border-color: #86EFAC;
            }
            
            .division-checkbox input {
                margin-top: 2px;
                width: 18px;
                height: 18px;
                cursor: inherit;
            }
            
            .division-checkbox-content {
                flex: 1;
                display: flex;
                flex-direction: column;
                gap: 4px;
            }
            
            .division-name {
                font-weight: 600;
                color: var(--slate-800);
            }
            
            .division-subdivision {
                font-size: 0.75rem;
                padding: 2px 8px;
                border-radius: 999px;
                display: inline-block;
                width: fit-content;
            }
            
            .division-status {
                font-size: 0.75rem;
                color: var(--slate-500);
            }
            
            .division-selector-actions {
                display: flex;
                gap: 8px;
                margin-bottom: 16px;
                padding-bottom: 16px;
                border-bottom: 1px solid var(--slate-200);
            }
            
            .division-selector-footer {
                display: flex;
                justify-content: flex-end;
                gap: 12px;
            }
            
            .division-selector-advanced {
                margin-top: 16px;
                padding-top: 16px;
                border-top: 1px solid var(--slate-200);
            }
            
            .division-selector-advanced summary {
                cursor: pointer;
                color: var(--slate-500);
                font-size: 0.9rem;
            }
            
            .division-selector-advanced summary:hover {
                color: var(--slate-700);
            }
            
            /* Button styles */
            .division-selector-modal .btn-primary {
                background: linear-gradient(135deg, #6366F1, #4F46E5);
                color: white;
                border: none;
                padding: 10px 20px;
                border-radius: 8px;
                font-weight: 600;
                cursor: pointer;
                transition: all 0.15s;
            }
            
            .division-selector-modal .btn-primary:hover:not(:disabled) {
                transform: translateY(-1px);
                box-shadow: 0 4px 12px rgba(99, 102, 241, 0.4);
            }
            
            .division-selector-modal .btn-primary:disabled {
                opacity: 0.5;
                cursor: not-allowed;
            }
            
            .division-selector-modal .btn-secondary {
                background: var(--slate-100);
                color: var(--slate-700);
                border: none;
                padding: 10px 20px;
                border-radius: 8px;
                font-weight: 500;
                cursor: pointer;
            }
            
            .division-selector-modal .btn-secondary:hover {
                background: var(--slate-200);
            }
            
            .division-selector-modal .btn-ghost {
                background: none;
                border: none;
                color: var(--slate-600);
                padding: 6px 12px;
                font-size: 0.85rem;
                cursor: pointer;
            }
            
            .division-selector-modal .btn-ghost:hover {
                color: var(--slate-900);
                background: var(--slate-100);
                border-radius: 6px;
            }
        `;
        document.head.appendChild(styles);
    }

    // =========================================================================
    // EXPORTS
    // =========================================================================

    const DivisionSelector = {
        initialize,
        renderDivisionSelector,
        getExistingLocks,
        getGeneratedDivisions,
        saveLocks,
        clearAllLocks,
        mergeLocks,
        injectStyles
    };

    window.DivisionSelector = DivisionSelector;

    // Inject styles
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', injectStyles);
    } else {
        injectStyles();
    }

    console.log("☑️ Division Selector loaded");

})();
