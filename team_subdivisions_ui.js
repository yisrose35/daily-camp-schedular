// ============================================================================
// team_subdivisions_ui.js — Team & Subdivisions Management UI
// ============================================================================
// Provides UI components for:
// - Managing subdivisions (grouping divisions)
// - Inviting and managing team members
// - Viewing team access permissions
// ============================================================================

(function() {
    'use strict';

    console.log("👥 Team & Subdivisions UI v1.0 loading...");

    // =========================================================================
    // STATE
    // =========================================================================

    let _teamMembers = [];
    let _subdivisions = [];
    let _allDivisions = [];
    let _isOwner = false;

    // =========================================================================
    // INITIALIZATION
    // =========================================================================

    async function initialize() {
        // Wait for AccessControl
        let attempts = 0;
        while (!window.AccessControl && attempts < 50) {
            await new Promise(r => setTimeout(r, 100));
            attempts++;
        }

        if (!window.AccessControl) {
            console.error("👥 AccessControl not available");
            return;
        }

        // Wait for it to initialize
        await window.AccessControl.initialize();

        _isOwner = window.AccessControl.getCurrentRole() === 'owner';
        _subdivisions = window.AccessControl.getSubdivisions();
        
        // Get all divisions from global state
        _allDivisions = Object.keys(window.divisions || {});

        // Load team members
        const { data } = await window.AccessControl.getTeamMembers();
        _teamMembers = data;

        console.log("👥 Team UI initialized:", {
            isOwner: _isOwner,
            teamMembers: _teamMembers.length,
            subdivisions: _subdivisions.length
        });
    }

    // =========================================================================
    // SUBDIVISIONS UI
    // =========================================================================

    function renderSubdivisionsCard(container) {
        if (!container) return;

        const canManage = window.AccessControl?.canManageSubdivisions();

        container.innerHTML = `
            <div class="card-header">
                <h2>Subdivisions</h2>
                ${canManage ? `
                    <button class="btn-edit" id="add-subdivision-btn">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <line x1="12" y1="5" x2="12" y2="19"></line>
                            <line x1="5" y1="12" x2="19" y2="12"></line>
                        </svg>
                        Add
                    </button>
                ` : ''}
            </div>
            
            <p style="font-size: 0.85rem; color: var(--slate-500); margin-bottom: 16px;">
                Group divisions together and assign schedulers to specific subdivisions.
            </p>
            
            <div id="subdivisions-list">
                ${_subdivisions.length === 0 ? `
                    <div style="text-align: center; padding: 24px; color: var(--slate-400);">
                        <div style="font-size: 2rem; margin-bottom: 8px;">📁</div>
                        <div>No subdivisions created yet</div>
                        ${canManage ? `<div style="font-size: 0.85rem; margin-top: 4px;">Click "Add" to create one</div>` : ''}
                    </div>
                ` : _subdivisions.map(sub => renderSubdivisionItem(sub, canManage)).join('')}
            </div>
            
            <!-- Add/Edit Modal -->
            <div id="subdivision-modal" class="modal" style="display: none;">
                <div class="modal-content">
                    <div class="modal-header">
                        <h3 id="subdivision-modal-title">Add Subdivision</h3>
                        <button class="modal-close" onclick="TeamSubdivisionsUI.closeSubdivisionModal()">&times;</button>
                    </div>
                    <form id="subdivision-form">
                        <div class="form-group">
                            <label for="subdivision-name">Name</label>
                            <input type="text" id="subdivision-name" placeholder="e.g., Lower Camp" required>
                        </div>
                        <div class="form-group">
                            <label for="subdivision-color">Color</label>
                            <input type="color" id="subdivision-color" value="#6B7280">
                        </div>
                        <div class="form-group">
                            <label>Divisions</label>
                            <div id="subdivision-divisions-checkboxes" class="checkbox-grid">
                                ${_allDivisions.map(div => `
                                    <label class="checkbox-item">
                                        <input type="checkbox" name="divisions" value="${div}">
                                        <span>${div}</span>
                                    </label>
                                `).join('')}
                            </div>
                            ${_allDivisions.length === 0 ? `
                                <p style="color: var(--slate-400); font-size: 0.85rem;">
                                    No divisions found. Create divisions in Flow first.
                                </p>
                            ` : ''}
                        </div>
                        <input type="hidden" id="subdivision-edit-id">
                        <div class="form-actions">
                            <button type="button" class="btn-secondary" onclick="TeamSubdivisionsUI.closeSubdivisionModal()">Cancel</button>
                            <button type="submit" class="btn-primary">Save</button>
                        </div>
                        <div id="subdivision-form-error" class="form-error"></div>
                    </form>
                </div>
            </div>
        `;

        // Bind events
        const addBtn = document.getElementById('add-subdivision-btn');
        if (addBtn) {
            addBtn.onclick = () => openSubdivisionModal();
        }

        const form = document.getElementById('subdivision-form');
        if (form) {
            form.onsubmit = handleSubdivisionSubmit;
        }

        // Bind edit/delete buttons
        document.querySelectorAll('.edit-subdivision-btn').forEach(btn => {
            btn.onclick = () => openSubdivisionModal(btn.dataset.id);
        });

        document.querySelectorAll('.delete-subdivision-btn').forEach(btn => {
            btn.onclick = () => handleDeleteSubdivision(btn.dataset.id);
        });
    }

    function renderSubdivisionItem(sub, canManage) {
        const divisionCount = sub.divisions?.length || 0;
        const divisionList = sub.divisions?.slice(0, 3).join(', ') || 'No divisions';
        const moreCount = divisionCount > 3 ? ` +${divisionCount - 3} more` : '';

        return `
            <div class="subdivision-item" style="
                display: flex;
                align-items: center;
                gap: 12px;
                padding: 12px;
                background: var(--slate-50);
                border-radius: 10px;
                margin-bottom: 8px;
                border-left: 4px solid ${sub.color || '#6B7280'};
            ">
                <div style="flex: 1;">
                    <div style="font-weight: 600; color: var(--slate-800);">${sub.name}</div>
                    <div style="font-size: 0.85rem; color: var(--slate-500);">
                        ${divisionList}${moreCount}
                    </div>
                </div>
                ${canManage ? `
                    <button class="edit-subdivision-btn btn-ghost" data-id="${sub.id}" style="padding: 6px 10px; font-size: 0.8rem;">
                        Edit
                    </button>
                    <button class="delete-subdivision-btn" data-id="${sub.id}" style="
                        padding: 6px 10px;
                        background: none;
                        border: none;
                        color: var(--slate-400);
                        cursor: pointer;
                        font-size: 1.1rem;
                    ">🗑️</button>
                ` : ''}
            </div>
        `;
    }

    function openSubdivisionModal(editId = null) {
        const modal = document.getElementById('subdivision-modal');
        const title = document.getElementById('subdivision-modal-title');
        const nameInput = document.getElementById('subdivision-name');
        const colorInput = document.getElementById('subdivision-color');
        const editIdInput = document.getElementById('subdivision-edit-id');
        const checkboxes = document.querySelectorAll('#subdivision-divisions-checkboxes input[type="checkbox"]');

        // Reset form
        nameInput.value = '';
        colorInput.value = '#6B7280';
        editIdInput.value = '';
        checkboxes.forEach(cb => cb.checked = false);
        document.getElementById('subdivision-form-error').textContent = '';

        if (editId) {
            // Edit mode
            const sub = _subdivisions.find(s => s.id === editId);
            if (sub) {
                title.textContent = 'Edit Subdivision';
                nameInput.value = sub.name;
                colorInput.value = sub.color || '#6B7280';
                editIdInput.value = editId;
                
                // Check assigned divisions
                (sub.divisions || []).forEach(div => {
                    const cb = document.querySelector(`#subdivision-divisions-checkboxes input[value="${div}"]`);
                    if (cb) cb.checked = true;
                });
            }
        } else {
            title.textContent = 'Add Subdivision';
        }

        modal.style.display = 'flex';
    }

    function closeSubdivisionModal() {
        const modal = document.getElementById('subdivision-modal');
        if (modal) modal.style.display = 'none';
    }

    async function handleSubdivisionSubmit(e) {
        e.preventDefault();

        const name = document.getElementById('subdivision-name').value.trim();
        const color = document.getElementById('subdivision-color').value;
        const editId = document.getElementById('subdivision-edit-id').value;
        const errorEl = document.getElementById('subdivision-form-error');

        // Get checked divisions
        const divisions = [];
        document.querySelectorAll('#subdivision-divisions-checkboxes input[type="checkbox"]:checked').forEach(cb => {
            divisions.push(cb.value);
        });

        if (!name) {
            errorEl.textContent = 'Name is required';
            return;
        }

        errorEl.textContent = '';

        let result;
        if (editId) {
            result = await window.AccessControl.updateSubdivision(editId, { name, color, divisions });
        } else {
            result = await window.AccessControl.createSubdivision(name, divisions, color);
        }

        if (result.error) {
            errorEl.textContent = result.error;
            return;
        }

        // Refresh
        _subdivisions = window.AccessControl.getSubdivisions();
        closeSubdivisionModal();
        
        const container = document.getElementById('subdivisions-card');
        if (container) renderSubdivisionsCard(container);
    }

    async function handleDeleteSubdivision(id) {
        const sub = _subdivisions.find(s => s.id === id);
        if (!sub) return;

        if (!confirm(`Delete "${sub.name}"?\n\nThis will remove the subdivision but won't delete any divisions or schedules.`)) {
            return;
        }

        const result = await window.AccessControl.deleteSubdivision(id);

        if (result.error) {
            alert('Error: ' + result.error);
            return;
        }

        _subdivisions = window.AccessControl.getSubdivisions();
        const container = document.getElementById('subdivisions-card');
        if (container) renderSubdivisionsCard(container);
    }

    // =========================================================================
    // TEAM MANAGEMENT UI
    // =========================================================================

    function renderTeamCard(container) {
        if (!container) return;

        const canManage = window.AccessControl?.canManageTeam();
        const currentRole = window.AccessControl?.getCurrentRole();

        container.innerHTML = `
            <div class="card-header">
                <h2>Team Members</h2>
                ${canManage ? `
                    <button class="btn-edit" id="invite-member-btn">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path>
                            <circle cx="8.5" cy="7" r="4"></circle>
                            <line x1="20" y1="8" x2="20" y2="14"></line>
                            <line x1="17" y1="11" x2="23" y2="11"></line>
                        </svg>
                        Invite
                    </button>
                ` : ''}
            </div>
            
            <div id="team-members-list">
                ${_teamMembers.length === 0 ? `
                    <div style="text-align: center; padding: 24px; color: var(--slate-400);">
                        <div style="font-size: 2rem; margin-bottom: 8px;">👥</div>
                        <div>No team members yet</div>
                        ${canManage ? `<div style="font-size: 0.85rem; margin-top: 4px;">Click "Invite" to add someone</div>` : ''}
                    </div>
                ` : _teamMembers.map(member => renderTeamMemberItem(member, canManage)).join('')}
            </div>
            
            <!-- You are shown separately -->
            <div style="margin-top: 16px; padding-top: 16px; border-top: 1px solid var(--slate-200);">
                <div style="font-size: 0.85rem; color: var(--slate-500); margin-bottom: 8px;">Your access</div>
                <div style="display: flex; align-items: center; gap: 8px;">
                    <span class="role-badge" style="background: ${window.AccessControl?.getRoleColor(currentRole)}20; color: ${window.AccessControl?.getRoleColor(currentRole)};">
                        ${window.AccessControl?.getRoleDisplayName(currentRole)}
                    </span>
                    <span style="color: var(--slate-600);">
                        ${currentRole === 'owner' || currentRole === 'admin' 
                            ? 'Full access to all divisions' 
                            : currentRole === 'viewer'
                                ? 'View only'
                                : `Can edit: ${window.AccessControl?.getEditableDivisions().join(', ') || 'None'}`
                        }
                    </span>
                </div>
            </div>
            
            <!-- Invite Modal -->
            <div id="invite-modal" class="modal" style="display: none;">
                <div class="modal-content">
                    <div class="modal-header">
                        <h3>Invite Team Member</h3>
                        <button class="modal-close" onclick="TeamSubdivisionsUI.closeInviteModal()">&times;</button>
                    </div>
                    <form id="invite-form">
                        <div class="form-group">
                            <label for="invite-email">Email</label>
                            <input type="email" id="invite-email" placeholder="scheduler@example.com" required>
                        </div>
                        <div class="form-group">
                            <label for="invite-role">Role</label>
                            <select id="invite-role" required>
                                <option value="viewer">Viewer — Can view all, cannot edit</option>
                                <option value="scheduler">Scheduler — Can edit assigned subdivisions</option>
                                <option value="admin">Admin — Can edit everything</option>
                            </select>
                        </div>
                        <div class="form-group" id="invite-subdivisions-group" style="display: none;">
                            <label>Assign to Subdivisions</label>
                            <div id="invite-subdivisions-checkboxes" class="checkbox-grid">
                                ${_subdivisions.map(sub => `
                                    <label class="checkbox-item">
                                        <input type="checkbox" name="subdivisions" value="${sub.id}">
                                        <span>${sub.name}</span>
                                    </label>
                                `).join('')}
                            </div>
                            ${_subdivisions.length === 0 ? `
                                <p style="color: var(--slate-400); font-size: 0.85rem;">
                                    No subdivisions created. Create subdivisions first, or leave empty to give access to all divisions.
                                </p>
                            ` : ''}
                        </div>
                        <div class="form-actions">
                            <button type="button" class="btn-secondary" onclick="TeamSubdivisionsUI.closeInviteModal()">Cancel</button>
                            <button type="submit" class="btn-primary">Send Invite</button>
                        </div>
                        <div id="invite-form-error" class="form-error"></div>
                        <div id="invite-form-success" class="form-success"></div>
                    </form>
                </div>
            </div>
        `;

        // Bind events
        const inviteBtn = document.getElementById('invite-member-btn');
        if (inviteBtn) {
            inviteBtn.onclick = openInviteModal;
        }

        const inviteForm = document.getElementById('invite-form');
        if (inviteForm) {
            inviteForm.onsubmit = handleInviteSubmit;
        }

        const roleSelect = document.getElementById('invite-role');
        if (roleSelect) {
            roleSelect.onchange = () => {
                const subGroup = document.getElementById('invite-subdivisions-group');
                subGroup.style.display = roleSelect.value === 'scheduler' ? 'block' : 'none';
            };
        }

        // Bind remove buttons
        document.querySelectorAll('.remove-member-btn').forEach(btn => {
            btn.onclick = () => handleRemoveMember(btn.dataset.id);
        });
    }

    function renderTeamMemberItem(member, canManage) {
        const roleColor = window.AccessControl?.getRoleColor(member.role) || '#6B7280';
        const isPending = !member.accepted_at;
        
        // Get subdivision names
        let subdivisionNames = 'All divisions';
        if (member.subdivision_ids && member.subdivision_ids.length > 0) {
            const names = member.subdivision_ids
                .map(id => _subdivisions.find(s => s.id === id)?.name)
                .filter(Boolean);
            subdivisionNames = names.length > 0 ? names.join(', ') : 'All divisions';
        }

        return `
            <div class="team-member-item" style="
                display: flex;
                align-items: center;
                gap: 12px;
                padding: 12px;
                background: ${isPending ? '#FEF3C7' : 'var(--slate-50)'};
                border-radius: 10px;
                margin-bottom: 8px;
            ">
                <div style="
                    width: 40px;
                    height: 40px;
                    border-radius: 50%;
                    background: ${roleColor}20;
                    color: ${roleColor};
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    font-weight: 600;
                ">
                    ${member.email.substring(0, 2).toUpperCase()}
                </div>
                <div style="flex: 1;">
                    <div style="display: flex; align-items: center; gap: 8px;">
                        <span style="font-weight: 500; color: var(--slate-800);">${member.email}</span>
                        ${isPending ? `
                            <span style="
                                font-size: 0.7rem;
                                padding: 2px 8px;
                                background: #F59E0B;
                                color: white;
                                border-radius: 999px;
                            ">Pending</span>
                        ` : ''}
                    </div>
                    <div style="font-size: 0.85rem; color: var(--slate-500);">
                        <span class="role-badge" style="
                            display: inline-block;
                            padding: 2px 8px;
                            background: ${roleColor}15;
                            color: ${roleColor};
                            border-radius: 999px;
                            font-size: 0.75rem;
                            font-weight: 600;
                            margin-right: 8px;
                        ">${window.AccessControl?.getRoleDisplayName(member.role)}</span>
                        ${member.role === 'scheduler' ? subdivisionNames : ''}
                    </div>
                </div>
                ${canManage ? `
                    <button class="remove-member-btn" data-id="${member.id}" style="
                        padding: 6px 10px;
                        background: none;
                        border: none;
                        color: var(--slate-400);
                        cursor: pointer;
                        font-size: 1.1rem;
                    " title="Remove member">🗑️</button>
                ` : ''}
            </div>
        `;
    }

    function openInviteModal() {
        const modal = document.getElementById('invite-modal');
        const emailInput = document.getElementById('invite-email');
        const roleSelect = document.getElementById('invite-role');
        const subGroup = document.getElementById('invite-subdivisions-group');
        
        // Reset form
        emailInput.value = '';
        roleSelect.value = 'viewer';
        subGroup.style.display = 'none';
        document.querySelectorAll('#invite-subdivisions-checkboxes input').forEach(cb => cb.checked = false);
        document.getElementById('invite-form-error').textContent = '';
        document.getElementById('invite-form-success').textContent = '';
        
        modal.style.display = 'flex';
    }

    function closeInviteModal() {
        const modal = document.getElementById('invite-modal');
        if (modal) modal.style.display = 'none';
    }

    async function handleInviteSubmit(e) {
        e.preventDefault();

        const email = document.getElementById('invite-email').value.trim();
        const role = document.getElementById('invite-role').value;
        const errorEl = document.getElementById('invite-form-error');
        const successEl = document.getElementById('invite-form-success');

        // Get checked subdivisions
        const subdivisionIds = [];
        document.querySelectorAll('#invite-subdivisions-checkboxes input[type="checkbox"]:checked').forEach(cb => {
            subdivisionIds.push(cb.value);
        });

        if (!email) {
            errorEl.textContent = 'Email is required';
            return;
        }

        errorEl.textContent = '';
        successEl.textContent = '';

        const result = await window.AccessControl.inviteTeamMember(email, role, subdivisionIds);

        if (result.error) {
            errorEl.textContent = result.error;
            return;
        }

        successEl.innerHTML = `
            ✅ Invite created!<br>
            <span style="font-size: 0.85rem;">Share this link with ${email}:</span><br>
            <input type="text" value="${result.inviteUrl}" readonly style="width: 100%; margin-top: 8px; font-size: 0.8rem;" onclick="this.select()">
        `;

        // Refresh team list
        const { data } = await window.AccessControl.getTeamMembers();
        _teamMembers = data;
        
        const container = document.getElementById('team-card');
        if (container) renderTeamCard(container);
    }

    async function handleRemoveMember(id) {
        const member = _teamMembers.find(m => m.id === id);
        if (!member) return;

        if (!confirm(`Remove ${member.email} from your team?\n\nThey will lose access to this camp.`)) {
            return;
        }

        const result = await window.AccessControl.removeTeamMember(id);

        if (result.error) {
            alert('Error: ' + result.error);
            return;
        }

        // Refresh
        const { data } = await window.AccessControl.getTeamMembers();
        _teamMembers = data;
        
        const container = document.getElementById('team-card');
        if (container) renderTeamCard(container);
    }

    // =========================================================================
    // CSS STYLES
    // =========================================================================

    function injectStyles() {
        if (document.getElementById('team-subdivisions-styles')) return;

        const styles = document.createElement('style');
        styles.id = 'team-subdivisions-styles';
        styles.textContent = `
            /* Modal styles */
            .modal {
                position: fixed;
                top: 0;
                left: 0;
                right: 0;
                bottom: 0;
                background: rgba(0, 0, 0, 0.5);
                display: flex;
                align-items: center;
                justify-content: center;
                z-index: 1000;
            }
            
            .modal-content {
                background: white;
                border-radius: 16px;
                padding: 24px;
                max-width: 500px;
                width: 90%;
                max-height: 90vh;
                overflow-y: auto;
                box-shadow: 0 20px 40px rgba(0, 0, 0, 0.2);
            }
            
            .modal-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 20px;
                padding-bottom: 16px;
                border-bottom: 1px solid var(--slate-200);
            }
            
            .modal-header h3 {
                margin: 0;
                font-size: 1.2rem;
                color: var(--slate-900);
            }
            
            .modal-close {
                background: none;
                border: none;
                font-size: 1.5rem;
                color: var(--slate-400);
                cursor: pointer;
                padding: 0;
                line-height: 1;
            }
            
            .modal-close:hover {
                color: var(--slate-600);
            }
            
            /* Checkbox grid */
            .checkbox-grid {
                display: grid;
                grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
                gap: 8px;
                max-height: 200px;
                overflow-y: auto;
                padding: 8px;
                background: var(--slate-50);
                border-radius: 8px;
            }
            
            .checkbox-item {
                display: flex;
                align-items: center;
                gap: 8px;
                padding: 8px;
                background: white;
                border-radius: 6px;
                cursor: pointer;
                transition: background 0.15s;
            }
            
            .checkbox-item:hover {
                background: var(--slate-100);
            }
            
            .checkbox-item input {
                width: auto;
                margin: 0;
            }
            
            .checkbox-item span {
                font-size: 0.9rem;
                color: var(--slate-700);
            }
            
            /* Role badge */
            .role-badge {
                display: inline-block;
                padding: 4px 10px;
                border-radius: 999px;
                font-size: 0.75rem;
                font-weight: 600;
                text-transform: capitalize;
            }
        `;
        document.head.appendChild(styles);
    }

    // =========================================================================
    // EXPORTS
    // =========================================================================

    const TeamSubdivisionsUI = {
        initialize,
        renderSubdivisionsCard,
        renderTeamCard,
        openSubdivisionModal,
        closeSubdivisionModal,
        openInviteModal,
        closeInviteModal,
        injectStyles
    };

    window.TeamSubdivisionsUI = TeamSubdivisionsUI;

    // Inject styles immediately
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', injectStyles);
    } else {
        injectStyles();
    }

    console.log("👥 Team & Subdivisions UI loaded");

})();
