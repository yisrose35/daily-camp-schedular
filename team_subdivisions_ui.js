// ============================================================================
// team_subdivisions_ui.js — Team & Subdivisions Management UI
// ============================================================================
// Provides UI components for managing subdivisions and team members
// Allows creating subdivisions with division names before divisions exist
// ============================================================================

(function() {
    'use strict';

    console.log("👥 Team & Subdivisions UI v1.1 loading...");

    // =========================================================================
    // BEAUTIFUL COLOR PALETTE
    // =========================================================================
    
    const SUBDIVISION_COLORS = [
        '#6366F1', // Indigo
        '#8B5CF6', // Violet
        '#EC4899', // Pink
        '#F43F5E', // Rose
        '#F97316', // Orange
        '#EAB308', // Yellow
        '#22C55E', // Green
        '#14B8A6', // Teal
        '#06B6D4', // Cyan
        '#3B82F6', // Blue
        '#A855F7', // Purple
        '#10B981', // Emerald
    ];

    let _colorIndex = 0;
    let _initialized = false;
    let _subdivisions = [];
    let _teamMembers = [];

    // =========================================================================
    // INITIALIZATION
    // =========================================================================

    async function initialize() {
        if (_initialized) return;

        // Wait for AccessControl
        let attempts = 0;
        while (!window.AccessControl && attempts < 50) {
            await new Promise(r => setTimeout(r, 100));
            attempts++;
        }

        if (!window.AccessControl) {
            console.warn("👥 AccessControl not available");
            return;
        }

        // Load data
        await refreshData();
        
        _initialized = true;
        console.log("👥 Team & Subdivisions UI initialized");
    }

    async function refreshData() {
        _subdivisions = window.AccessControl.getSubdivisions() || [];
        
        const teamResult = await window.AccessControl.getTeamMembers();
        _teamMembers = teamResult.data || [];
        
        // Update color index based on existing subdivisions
        _colorIndex = _subdivisions.length % SUBDIVISION_COLORS.length;
    }

    // =========================================================================
    // GET NEXT COLOR
    // =========================================================================

    function getNextColor() {
        const color = SUBDIVISION_COLORS[_colorIndex];
        _colorIndex = (_colorIndex + 1) % SUBDIVISION_COLORS.length;
        return color;
    }

    // =========================================================================
    // SUBDIVISIONS CARD
    // =========================================================================

    function renderSubdivisionsCard(container) {
        if (!container) return;

        const subdivisions = window.AccessControl?.getSubdivisions() || [];

        container.innerHTML = `
            <div class="card-header">
                <h2>Subdivisions</h2>
                <button class="btn-edit" id="add-subdivision-btn">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <line x1="12" y1="5" x2="12" y2="19"></line>
                        <line x1="5" y1="12" x2="19" y2="12"></line>
                    </svg>
                    Add
                </button>
            </div>
            <p style="color: var(--slate-500); font-size: 0.9rem; margin-bottom: 1rem;">
                Group divisions together and assign schedulers to manage them.
            </p>
            
            <div id="subdivisions-list">
                ${subdivisions.length === 0 ? `
                    <div class="empty-state">
                        <div style="font-size: 2rem; margin-bottom: 8px;">📂</div>
                        <p style="color: var(--slate-500); margin: 0;">No subdivisions yet</p>
                        <p style="color: var(--slate-400); font-size: 0.85rem; margin-top: 4px;">
                            Create subdivisions to organize divisions and assign schedulers
                        </p>
                    </div>
                ` : subdivisions.map(sub => renderSubdivisionItem(sub)).join('')}
            </div>
        `;

        // Bind add button
        document.getElementById('add-subdivision-btn')?.addEventListener('click', () => {
            showSubdivisionModal();
        });

        // Bind edit/delete buttons
        container.querySelectorAll('.subdivision-edit-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const id = btn.dataset.id;
                const sub = subdivisions.find(s => s.id === id);
                if (sub) showSubdivisionModal(sub);
            });
        });

        container.querySelectorAll('.subdivision-delete-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                const id = btn.dataset.id;
                if (confirm('Delete this subdivision? Team members assigned to it will lose their division access.')) {
                    await window.AccessControl.deleteSubdivision(id);
                    await refreshData();
                    renderSubdivisionsCard(container);
                }
            });
        });
    }

    function renderSubdivisionItem(sub) {
        const divisionsList = sub.divisions?.length > 0 
            ? sub.divisions.join(', ')
            : '<em style="color: var(--slate-400);">No divisions assigned</em>';

        return `
            <div class="subdivision-item" style="border-left: 4px solid ${sub.color || '#6B7280'};">
                <div class="subdivision-info">
                    <div class="subdivision-name">${sub.name}</div>
                    <div class="subdivision-divisions">${divisionsList}</div>
                </div>
                <div class="subdivision-actions">
                    <button class="btn-icon subdivision-edit-btn" data-id="${sub.id}" title="Edit">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                            <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                        </svg>
                    </button>
                    <button class="btn-icon subdivision-delete-btn" data-id="${sub.id}" title="Delete">
                        <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                            <polyline points="3 6 5 6 21 6"></polyline>
                            <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                        </svg>
                    </button>
                </div>
            </div>
        `;
    }

    // =========================================================================
    // SUBDIVISION MODAL
    // =========================================================================

    function showSubdivisionModal(existingSubdivision = null) {
        const isEdit = !!existingSubdivision;
        const defaultColor = isEdit ? existingSubdivision.color : getNextColor();

        // Get existing divisions from window.divisions if available
        const existingDivisions = Object.keys(window.divisions || {});
        
        const modal = document.createElement('div');
        modal.className = 'modal-overlay';
        modal.id = 'subdivision-modal';
        modal.innerHTML = `
            <div class="modal-content">
                <div class="modal-header">
                    <h3>${isEdit ? 'Edit Subdivision' : 'Create Subdivision'}</h3>
                    <button class="modal-close" id="modal-close">&times;</button>
                </div>
                
                <form id="subdivision-form">
                    <div class="form-group">
                        <label for="sub-name">Subdivision Name *</label>
                        <input 
                            type="text" 
                            id="sub-name" 
                            placeholder="e.g., Upper Camp, Boys Division, Senior Units"
                            value="${isEdit ? existingSubdivision.name : ''}"
                            required
                        >
                    </div>
                    
                    <div class="form-group">
                        <label for="sub-color">Color</label>
                        <div class="color-picker-row">
                            <input 
                                type="color" 
                                id="sub-color" 
                                value="${defaultColor}"
                                style="width: 50px; height: 40px; cursor: pointer; border-radius: 8px; border: 2px solid var(--slate-200);"
                            >
                            <div class="color-presets">
                                ${SUBDIVISION_COLORS.map(c => `
                                    <button 
                                        type="button" 
                                        class="color-preset ${c === defaultColor ? 'selected' : ''}" 
                                        data-color="${c}"
                                        style="background: ${c};"
                                    ></button>
                                `).join('')}
                            </div>
                        </div>
                    </div>
                    
                    <div class="form-group">
                        <label>Divisions</label>
                        <p style="font-size: 0.85rem; color: var(--slate-500); margin-bottom: 8px;">
                            Select existing divisions or type new ones. New division names will be recognized when you create them in Flow.
                        </p>
                        
                        ${existingDivisions.length > 0 ? `
                            <div class="division-checkboxes" style="margin-bottom: 12px;">
                                ${existingDivisions.map(div => `
                                    <label class="checkbox-item">
                                        <input 
                                            type="checkbox" 
                                            name="division" 
                                            value="${div}"
                                            ${isEdit && existingSubdivision.divisions?.includes(div) ? 'checked' : ''}
                                        >
                                        <span>${div}</span>
                                    </label>
                                `).join('')}
                            </div>
                        ` : ''}
                        
                        <div class="divisions-tags-input">
                            <div id="division-tags" class="tags-container">
                                ${isEdit && existingSubdivision.divisions ? 
                                    existingSubdivision.divisions
                                        .filter(d => !existingDivisions.includes(d))
                                        .map(d => `<span class="tag">${d}<button type="button" class="tag-remove" data-div="${d}">&times;</button></span>`)
                                        .join('') 
                                    : ''
                                }
                            </div>
                            <input 
                                type="text" 
                                id="division-input" 
                                placeholder="Type division name and press Enter..."
                                style="flex: 1; min-width: 200px;"
                            >
                        </div>
                        <p style="font-size: 0.8rem; color: var(--slate-400); margin-top: 6px;">
                            💡 Tip: You can add division names now even if they don't exist yet in Flow
                        </p>
                    </div>
                    
                    <div id="subdivision-error" class="form-error"></div>
                    
                    <div class="form-actions">
                        <button type="button" class="btn-secondary" id="cancel-subdivision">Cancel</button>
                        <button type="submit" class="btn-primary">
                            ${isEdit ? 'Save Changes' : 'Create Subdivision'}
                        </button>
                    </div>
                </form>
            </div>
        `;

        document.body.appendChild(modal);

        // Division tags state
        const customDivisions = new Set(
            isEdit && existingSubdivision.divisions 
                ? existingSubdivision.divisions.filter(d => !existingDivisions.includes(d))
                : []
        );

        // Color preset clicks
        modal.querySelectorAll('.color-preset').forEach(btn => {
            btn.addEventListener('click', () => {
                document.getElementById('sub-color').value = btn.dataset.color;
                modal.querySelectorAll('.color-preset').forEach(b => b.classList.remove('selected'));
                btn.classList.add('selected');
            });
        });

        // Division tag input
        const divisionInput = document.getElementById('division-input');
        const tagsContainer = document.getElementById('division-tags');

        divisionInput.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ',') {
                e.preventDefault();
                const value = divisionInput.value.trim().replace(/,/g, '');
                if (value && !customDivisions.has(value) && !existingDivisions.includes(value)) {
                    customDivisions.add(value);
                    renderTags();
                }
                divisionInput.value = '';
            }
        });

        function renderTags() {
            tagsContainer.innerHTML = [...customDivisions].map(d => 
                `<span class="tag">${d}<button type="button" class="tag-remove" data-div="${d}">&times;</button></span>`
            ).join('');

            tagsContainer.querySelectorAll('.tag-remove').forEach(btn => {
                btn.addEventListener('click', () => {
                    customDivisions.delete(btn.dataset.div);
                    renderTags();
                });
            });
        }

        // Remove tag buttons
        modal.querySelectorAll('.tag-remove').forEach(btn => {
            btn.addEventListener('click', () => {
                customDivisions.delete(btn.dataset.div);
                renderTags();
            });
        });

        // Close handlers
        const closeModal = () => modal.remove();
        document.getElementById('modal-close').addEventListener('click', closeModal);
        document.getElementById('cancel-subdivision').addEventListener('click', closeModal);
        modal.addEventListener('click', (e) => {
            if (e.target === modal) closeModal();
        });

        // Form submission
        document.getElementById('subdivision-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const name = document.getElementById('sub-name').value.trim();
            const color = document.getElementById('sub-color').value;
            const errorEl = document.getElementById('subdivision-error');
            
            if (!name) {
                errorEl.textContent = 'Please enter a subdivision name';
                return;
            }

            // Collect all divisions (checked boxes + custom tags)
            const checkedDivisions = [...modal.querySelectorAll('input[name="division"]:checked')]
                .map(cb => cb.value);
            const allDivisions = [...new Set([...checkedDivisions, ...customDivisions])];

            try {
                let result;
                if (isEdit) {
                    result = await window.AccessControl.updateSubdivision(existingSubdivision.id, {
                        name,
                        color,
                        divisions: allDivisions
                    });
                } else {
                    result = await window.AccessControl.createSubdivision(name, allDivisions, color);
                }

                if (result.error) {
                    errorEl.textContent = result.error;
                    return;
                }

                closeModal();
                await refreshData();
                
                // Re-render the subdivisions card
                const container = document.getElementById('subdivisions-card');
                if (container) renderSubdivisionsCard(container);

            } catch (err) {
                errorEl.textContent = err.message || 'An error occurred';
            }
        });
    }

    // =========================================================================
    // TEAM MEMBERS CARD
    // =========================================================================

    function renderTeamCard(container) {
        if (!container) return;

        container.innerHTML = `
            <div class="card-header">
                <h2>Team Members</h2>
                <button class="btn-edit" id="invite-member-btn">
                    <svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                        <path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"></path>
                        <circle cx="8.5" cy="7" r="4"></circle>
                        <line x1="20" y1="8" x2="20" y2="14"></line>
                        <line x1="17" y1="11" x2="23" y2="11"></line>
                    </svg>
                    Invite
                </button>
            </div>
            <p style="color: var(--slate-500); font-size: 0.9rem; margin-bottom: 1rem;">
                Manage who can access and edit your camp schedules.
            </p>
            
            <div id="team-members-list">
                ${_teamMembers.length === 0 ? `
                    <div class="empty-state">
                        <div style="font-size: 2rem; margin-bottom: 8px;">👤</div>
                        <p style="color: var(--slate-500); margin: 0;">Just you for now</p>
                        <p style="color: var(--slate-400); font-size: 0.85rem; margin-top: 4px;">
                            Invite team members to help manage schedules
                        </p>
                    </div>
                ` : _teamMembers.map(member => renderTeamMemberItem(member)).join('')}
            </div>
        `;

        // Bind invite button
        document.getElementById('invite-member-btn')?.addEventListener('click', () => {
            showInviteModal();
        });

        // Bind edit/remove buttons
        container.querySelectorAll('.member-edit-btn').forEach(btn => {
            btn.addEventListener('click', () => {
                const id = btn.dataset.id;
                const member = _teamMembers.find(m => m.id === id);
                if (member) showEditMemberModal(member);
            });
        });

        container.querySelectorAll('.member-remove-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                const id = btn.dataset.id;
                if (confirm('Remove this team member? They will lose access to this camp.')) {
                    await window.AccessControl.removeTeamMember(id);
                    await refreshData();
                    renderTeamCard(container);
                }
            });
        });
    }

    function renderTeamMemberItem(member) {
        const roleClass = `role-${member.role}`;
        const roleName = window.AccessControl?.getRoleDisplayName(member.role) || member.role;
        const isPending = !member.accepted_at;

        // Get subdivision names
        const subdivisions = window.AccessControl?.getSubdivisions() || [];
        const memberSubs = member.subdivision_ids?.map(id => {
            const sub = subdivisions.find(s => s.id === id);
            return sub?.name;
        }).filter(Boolean).join(', ') || '';

        return `
            <div class="team-member-item ${isPending ? 'pending' : ''}">
                <div class="member-info">
                    <div class="member-email">
                        ${member.email}
                        ${isPending ? '<span class="pending-badge">Pending</span>' : ''}
                    </div>
                    ${memberSubs ? `<div class="member-subdivisions">${memberSubs}</div>` : ''}
                </div>
                <div class="member-actions">
                    <span class="${roleClass}">${roleName}</span>
                    ${member.role !== 'owner' ? `
                        <button class="btn-icon member-edit-btn" data-id="${member.id}" title="Edit">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/>
                                <path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/>
                            </svg>
                        </button>
                        <button class="btn-icon member-remove-btn" data-id="${member.id}" title="Remove">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <polyline points="3 6 5 6 21 6"></polyline>
                                <path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"></path>
                            </svg>
                        </button>
                    ` : ''}
                </div>
            </div>
        `;
    }

    // =========================================================================
    // INVITE MODAL
    // =========================================================================

    function showInviteModal() {
        const subdivisions = window.AccessControl?.getSubdivisions() || [];

        const modal = document.createElement('div');
        modal.className = 'modal-overlay';
        modal.id = 'invite-modal';
        modal.innerHTML = `
            <div class="modal-content">
                <div class="modal-header">
                    <h3>Invite Team Member</h3>
                    <button class="modal-close" id="modal-close">&times;</button>
                </div>
                
                <form id="invite-form">
                    <div class="form-group">
                        <label for="invite-email">Email Address *</label>
                        <input 
                            type="email" 
                            id="invite-email" 
                            placeholder="colleague@example.com"
                            required
                        >
                    </div>
                    
                    <div class="form-group">
                        <label for="invite-role">Role *</label>
                        <select id="invite-role" required>
                            <option value="">Select a role...</option>
                            <option value="admin">Admin - Full access to all divisions</option>
                            <option value="scheduler">Scheduler - Access to assigned subdivisions</option>
                            <option value="viewer">Viewer - View only, no editing</option>
                        </select>
                    </div>
                    
                    <div class="form-group" id="subdivisions-group" style="display: none;">
                        <label>Assign to Subdivisions</label>
                        <p style="font-size: 0.85rem; color: var(--slate-500); margin-bottom: 8px;">
                            Select which subdivisions this person can manage
                        </p>
                        ${subdivisions.length > 0 ? `
                            <div class="subdivision-checkboxes">
                                ${subdivisions.map(sub => `
                                    <label class="checkbox-item" style="border-left: 3px solid ${sub.color}; padding-left: 10px;">
                                        <input type="checkbox" name="subdivision" value="${sub.id}">
                                        <span>${sub.name}</span>
                                        <small style="color: var(--slate-400); margin-left: 8px;">
                                            ${sub.divisions?.join(', ') || 'No divisions'}
                                        </small>
                                    </label>
                                `).join('')}
                            </div>
                        ` : `
                            <p style="color: var(--slate-500); font-style: italic;">
                                No subdivisions created yet. Create subdivisions first to assign schedulers to specific divisions.
                            </p>
                        `}
                    </div>
                    
                    <div id="invite-error" class="form-error"></div>
                    <div id="invite-success" class="form-success"></div>
                    
                    <div class="form-actions">
                        <button type="button" class="btn-secondary" id="cancel-invite">Cancel</button>
                        <button type="submit" class="btn-primary">Send Invite</button>
                    </div>
                </form>
            </div>
        `;

        document.body.appendChild(modal);

        // Show/hide subdivisions based on role
        const roleSelect = document.getElementById('invite-role');
        const subsGroup = document.getElementById('subdivisions-group');
        
        roleSelect.addEventListener('change', () => {
            subsGroup.style.display = roleSelect.value === 'scheduler' ? 'block' : 'none';
        });

        // Close handlers
        const closeModal = () => modal.remove();
        document.getElementById('modal-close').addEventListener('click', closeModal);
        document.getElementById('cancel-invite').addEventListener('click', closeModal);
        modal.addEventListener('click', (e) => {
            if (e.target === modal) closeModal();
        });

        // Form submission
        document.getElementById('invite-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const email = document.getElementById('invite-email').value.trim();
            const role = document.getElementById('invite-role').value;
            const errorEl = document.getElementById('invite-error');
            const successEl = document.getElementById('invite-success');
            
            errorEl.textContent = '';
            successEl.textContent = '';

            if (!email || !role) {
                errorEl.textContent = 'Please fill in all required fields';
                return;
            }

            // Get selected subdivisions
            const subdivisionIds = [...modal.querySelectorAll('input[name="subdivision"]:checked')]
                .map(cb => cb.value);

            try {
                const result = await window.AccessControl.inviteTeamMember(email, role, subdivisionIds);

                if (result.error) {
                    errorEl.textContent = result.error;
                    return;
                }

                // Show success with invite link
                successEl.innerHTML = `
                    ✅ Invite created! Share this link:<br>
                    <input 
                        type="text" 
                        value="${result.inviteUrl}" 
                        readonly 
                        style="width: 100%; margin-top: 8px; padding: 8px; font-size: 0.85rem;"
                        onclick="this.select()"
                    >
                `;

                // Refresh data
                await refreshData();
                
                // Close after delay
                setTimeout(() => {
                    closeModal();
                    const container = document.getElementById('team-card');
                    if (container) renderTeamCard(container);
                }, 5000);

            } catch (err) {
                errorEl.textContent = err.message || 'An error occurred';
            }
        });
    }

    // =========================================================================
    // EDIT MEMBER MODAL
    // =========================================================================

    function showEditMemberModal(member) {
        const subdivisions = window.AccessControl?.getSubdivisions() || [];

        const modal = document.createElement('div');
        modal.className = 'modal-overlay';
        modal.id = 'edit-member-modal';
        modal.innerHTML = `
            <div class="modal-content">
                <div class="modal-header">
                    <h3>Edit Team Member</h3>
                    <button class="modal-close" id="modal-close">&times;</button>
                </div>
                
                <p style="color: var(--slate-600); margin-bottom: 16px;">${member.email}</p>
                
                <form id="edit-member-form">
                    <div class="form-group">
                        <label for="edit-role">Role</label>
                        <select id="edit-role">
                            <option value="admin" ${member.role === 'admin' ? 'selected' : ''}>Admin</option>
                            <option value="scheduler" ${member.role === 'scheduler' ? 'selected' : ''}>Scheduler</option>
                            <option value="viewer" ${member.role === 'viewer' ? 'selected' : ''}>Viewer</option>
                        </select>
                    </div>
                    
                    <div class="form-group" id="edit-subdivisions-group" style="display: ${member.role === 'scheduler' ? 'block' : 'none'};">
                        <label>Subdivisions</label>
                        ${subdivisions.length > 0 ? `
                            <div class="subdivision-checkboxes">
                                ${subdivisions.map(sub => `
                                    <label class="checkbox-item" style="border-left: 3px solid ${sub.color}; padding-left: 10px;">
                                        <input 
                                            type="checkbox" 
                                            name="subdivision" 
                                            value="${sub.id}"
                                            ${member.subdivision_ids?.includes(sub.id) ? 'checked' : ''}
                                        >
                                        <span>${sub.name}</span>
                                    </label>
                                `).join('')}
                            </div>
                        ` : '<p style="color: var(--slate-500);">No subdivisions available</p>'}
                    </div>
                    
                    <div id="edit-member-error" class="form-error"></div>
                    
                    <div class="form-actions">
                        <button type="button" class="btn-secondary" id="cancel-edit">Cancel</button>
                        <button type="submit" class="btn-primary">Save Changes</button>
                    </div>
                </form>
            </div>
        `;

        document.body.appendChild(modal);

        // Show/hide subdivisions based on role
        const roleSelect = document.getElementById('edit-role');
        const subsGroup = document.getElementById('edit-subdivisions-group');
        
        roleSelect.addEventListener('change', () => {
            subsGroup.style.display = roleSelect.value === 'scheduler' ? 'block' : 'none';
        });

        // Close handlers
        const closeModal = () => modal.remove();
        document.getElementById('modal-close').addEventListener('click', closeModal);
        document.getElementById('cancel-edit').addEventListener('click', closeModal);
        modal.addEventListener('click', (e) => {
            if (e.target === modal) closeModal();
        });

        // Form submission
        document.getElementById('edit-member-form').addEventListener('submit', async (e) => {
            e.preventDefault();
            
            const role = document.getElementById('edit-role').value;
            const errorEl = document.getElementById('edit-member-error');
            
            const subdivisionIds = [...modal.querySelectorAll('input[name="subdivision"]:checked')]
                .map(cb => cb.value);

            try {
                const result = await window.AccessControl.updateTeamMember(member.id, {
                    role,
                    subdivision_ids: subdivisionIds
                });

                if (result.error) {
                    errorEl.textContent = result.error;
                    return;
                }

                closeModal();
                await refreshData();
                
                const container = document.getElementById('team-card');
                if (container) renderTeamCard(container);

            } catch (err) {
                errorEl.textContent = err.message || 'An error occurred';
            }
        });
    }

    // =========================================================================
    // INJECT STYLES
    // =========================================================================

    function injectStyles() {
        if (document.getElementById('team-subdivisions-styles')) return;

        const styles = document.createElement('style');
        styles.id = 'team-subdivisions-styles';
        styles.textContent = `
            /* Modal Styles */
            .modal-overlay {
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
            
            .modal-content {
                background: white;
                border-radius: 16px;
                padding: 24px;
                max-width: 500px;
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
            
            .modal-header {
                display: flex;
                justify-content: space-between;
                align-items: center;
                margin-bottom: 20px;
            }
            
            .modal-header h3 {
                margin: 0;
                font-size: 1.3rem;
            }
            
            .modal-close {
                background: none;
                border: none;
                font-size: 1.5rem;
                cursor: pointer;
                color: var(--slate-400);
                padding: 0;
                line-height: 1;
            }
            
            .modal-close:hover {
                color: var(--slate-600);
            }
            
            /* Subdivision Items */
            .subdivision-item {
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 12px 16px;
                background: var(--slate-50);
                border-radius: 8px;
                margin-bottom: 8px;
            }
            
            .subdivision-name {
                font-weight: 600;
                color: var(--slate-800);
            }
            
            .subdivision-divisions {
                font-size: 0.85rem;
                color: var(--slate-500);
                margin-top: 2px;
            }
            
            .subdivision-actions {
                display: flex;
                gap: 4px;
            }
            
            /* Team Member Items */
            .team-member-item {
                display: flex;
                justify-content: space-between;
                align-items: center;
                padding: 12px 0;
                border-bottom: 1px solid var(--slate-100);
            }
            
            .team-member-item:last-child {
                border-bottom: none;
            }
            
            .team-member-item.pending {
                opacity: 0.7;
            }
            
            .member-email {
                font-weight: 500;
                color: var(--slate-800);
            }
            
            .member-subdivisions {
                font-size: 0.8rem;
                color: var(--slate-500);
                margin-top: 2px;
            }
            
            .member-actions {
                display: flex;
                align-items: center;
                gap: 8px;
            }
            
            .pending-badge {
                font-size: 0.7rem;
                background: #FEF3C7;
                color: #92400E;
                padding: 2px 6px;
                border-radius: 4px;
                margin-left: 8px;
            }
            
            /* Button Styles */
            .btn-icon {
                background: none;
                border: none;
                padding: 6px;
                cursor: pointer;
                color: var(--slate-400);
                border-radius: 6px;
                transition: all 0.15s;
            }
            
            .btn-icon:hover {
                background: var(--slate-100);
                color: var(--slate-700);
            }
            
            /* Color Picker */
            .color-picker-row {
                display: flex;
                align-items: center;
                gap: 12px;
            }
            
            .color-presets {
                display: flex;
                flex-wrap: wrap;
                gap: 6px;
            }
            
            .color-preset {
                width: 28px;
                height: 28px;
                border-radius: 6px;
                border: 2px solid transparent;
                cursor: pointer;
                transition: all 0.15s;
            }
            
            .color-preset:hover {
                transform: scale(1.1);
            }
            
            .color-preset.selected {
                border-color: var(--slate-800);
                box-shadow: 0 0 0 2px white, 0 0 0 4px var(--slate-300);
            }
            
            /* Tags Input */
            .divisions-tags-input {
                display: flex;
                flex-wrap: wrap;
                gap: 8px;
                align-items: center;
                padding: 8px;
                border: 2px solid var(--slate-200);
                border-radius: 8px;
                background: white;
            }
            
            .divisions-tags-input:focus-within {
                border-color: #6366F1;
            }
            
            .tags-container {
                display: flex;
                flex-wrap: wrap;
                gap: 6px;
            }
            
            .tag {
                display: inline-flex;
                align-items: center;
                gap: 4px;
                padding: 4px 10px;
                background: #EEF2FF;
                color: #4338CA;
                border-radius: 999px;
                font-size: 0.85rem;
                font-weight: 500;
            }
            
            .tag-remove {
                background: none;
                border: none;
                color: #4338CA;
                cursor: pointer;
                font-size: 1rem;
                line-height: 1;
                padding: 0;
                margin-left: 2px;
            }
            
            .tag-remove:hover {
                color: #DC2626;
            }
            
            .divisions-tags-input input {
                border: none;
                outline: none;
                padding: 4px;
                font-size: 0.95rem;
            }
            
            /* Checkbox Items */
            .checkbox-item {
                display: flex;
                align-items: center;
                gap: 8px;
                padding: 8px 0;
            }
            
            .checkbox-item input[type="checkbox"] {
                width: 18px;
                height: 18px;
            }
            
            .division-checkboxes,
            .subdivision-checkboxes {
                max-height: 200px;
                overflow-y: auto;
                padding: 4px;
            }
            
            /* Empty State */
            .empty-state {
                text-align: center;
                padding: 24px;
                background: var(--slate-50);
                border-radius: 12px;
                border: 2px dashed var(--slate-200);
            }
            
            /* Form Styles */
            .form-group {
                margin-bottom: 16px;
            }
            
            .form-group label {
                display: block;
                font-weight: 500;
                color: var(--slate-700);
                margin-bottom: 6px;
            }
            
            .form-group input[type="text"],
            .form-group input[type="email"],
            .form-group select {
                width: 100%;
                padding: 10px 14px;
                border: 2px solid var(--slate-200);
                border-radius: 8px;
                font-size: 0.95rem;
                transition: border-color 0.15s;
            }
            
            .form-group input:focus,
            .form-group select:focus {
                outline: none;
                border-color: #6366F1;
            }
            
            .form-actions {
                display: flex;
                justify-content: flex-end;
                gap: 12px;
                margin-top: 20px;
                padding-top: 16px;
                border-top: 1px solid var(--slate-200);
            }
            
            .form-error {
                background: #FEE2E2;
                color: #DC2626;
                padding: 10px 14px;
                border-radius: 8px;
                font-size: 0.9rem;
                margin-top: 12px;
            }
            
            .form-error:empty {
                display: none;
            }
            
            .form-success {
                background: #D1FAE5;
                color: #059669;
                padding: 10px 14px;
                border-radius: 8px;
                font-size: 0.9rem;
                margin-top: 12px;
            }
            
            .form-success:empty {
                display: none;
            }
        `;
        document.head.appendChild(styles);
    }

    // =========================================================================
    // EXPORTS
    // =========================================================================

    const TeamSubdivisionsUI = {
        initialize,
        refreshData,
        renderSubdivisionsCard,
        renderTeamCard,
        showSubdivisionModal,
        showInviteModal,
        getNextColor,
        SUBDIVISION_COLORS,
        injectStyles
    };

    window.TeamSubdivisionsUI = TeamSubdivisionsUI;

    // Inject styles
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', injectStyles);
    } else {
        injectStyles();
    }

    console.log("👥 Team & Subdivisions UI loaded");

})();
