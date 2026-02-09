// ============================================================================
// team_subdivisions_ui.js — Team & Divisions Management UI
// ============================================================================
// Provides UI components for managing divisions (synced from Campistry Me)
// and team members with invite/role management
// ============================================================================

(function() {
    'use strict';

    console.log("[TeamUI] Team & Divisions UI v2.0 loading...");

    // =========================================================================
    // BEAUTIFUL COLOR PALETTE
    // =========================================================================
    
    const SUBDIVISION_COLORS = [
        '#147D91', // Teal (brand primary)
        '#8B5CF6', // Violet
        '#EC4899', // Pink
        '#F43F5E', // Rose
        '#F97316', // Orange
        '#EAB308', // Yellow
        '#22C55E', // Green
        '#14B8A6', // Teal light
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
            console.warn("[TeamUI] AccessControl not available");
            return;
        }

        // Load data
        await refreshData();
        
        _initialized = true;
        console.log("[TeamUI] Team & Divisions UI initialized");
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
    // DIVISIONS CARD (reads directly from Campistry Me campStructure)
    // =========================================================================

    async function renderSubdivisionsCard(container) {
        if (!container) return;

        // Load divisions directly from Campistry Me (campStructure in camp_state)
        let meDivisions = {};
        try {
            const campId = localStorage.getItem('campistry_camp_id') || 
                           localStorage.getItem('campistry_user_id');
            if (campId && window.supabase) {
                const { data } = await window.supabase
                    .from('camp_state')
                    .select('state')
                    .eq('camp_id', campId)
                    .maybeSingle();
                if (data?.state) {
                    meDivisions = data.state.campStructure || {};
                }
            }
        } catch (e) {
            console.warn('[TeamUI] Could not load campStructure:', e);
        }

        const divisionNames = Object.keys(meDivisions);

        container.innerHTML = `
            <div class="card-header">
                <h2>Divisions</h2>
            </div>
            <p style="color: var(--slate-500); font-size: 0.9rem; margin-bottom: 1rem;">
                Divisions are synced from Campistry Me.
            </p>
            
            <div id="subdivisions-list">
                ${divisionNames.length === 0 ? `
                    <div class="empty-state">
                        <div style="margin-bottom: 8px; color: var(--slate-400);">
                            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M22 19a2 2 0 0 1-2 2H4a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h5l2 3h9a2 2 0 0 1 2 2z"/></svg>
                        </div>
                        <p style="color: var(--slate-600); margin: 0; font-weight: 500;">No divisions yet</p>
                        <p style="color: var(--slate-400); font-size: 0.85rem; margin-top: 6px;">
                            <a href="campistry_me.html" style="color: var(--camp-green, #147D91); font-weight: 600; text-decoration: none;">Create divisions in Campistry Me</a> to get started
                        </p>
                    </div>
                ` : divisionNames.map(name => {
                    const div = meDivisions[name];
                    const gradeNames = Object.keys(div.grades || {});
                    const gradeText = gradeNames.length > 0 
                        ? gradeNames.join(', ') 
                        : '<em style="color: var(--slate-400);">No grades yet</em>';
                    const color = div.color || '#6B7280';
                    return `
                        <div class="subdivision-item" style="border-left: 4px solid ${color};">
                            <div class="subdivision-info">
                                <div class="subdivision-name">${name}</div>
                                <div class="subdivision-divisions">${gradeText}</div>
                            </div>
                        </div>
                    `;
                }).join('')}
            </div>
        `;
    }

    // =========================================================================
    // SUBDIVISION MODAL (kept for editing subdivisions used in RBAC assignment)
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
                    <h3>${isEdit ? 'Edit Division' : 'Create Division'}</h3>
                    <button class="modal-close" id="modal-close">&times;</button>
                </div>
                
                <form id="subdivision-form">
                    <div class="form-group">
                        <label for="sub-name">Division Name *</label>
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
                        <label>Grades</label>
                        <p style="font-size: 0.85rem; color: var(--slate-500); margin-bottom: 8px;">
                            Select existing divisions or type new ones.
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
                                placeholder="Type grade name and press Enter..."
                                style="flex: 1; min-width: 200px;"
                            >
                        </div>
                    </div>
                    
                    <div id="subdivision-error" class="form-error"></div>
                    
                    <div class="form-actions">
                        <button type="button" class="btn-secondary" id="cancel-subdivision">Cancel</button>
                        <button type="submit" class="btn-primary">
                            ${isEdit ? 'Save Changes' : 'Create Division'}
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
                errorEl.textContent = 'Please enter a division name';
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
                
                // Re-render the divisions card
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
                        <div style="margin-bottom: 8px; color: var(--slate-400);">
                            <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>
                        </div>
                        <p style="color: var(--slate-600); margin: 0; font-weight: 500;">No team members yet</p>
                        <p style="color: var(--slate-400); font-size: 0.85rem; margin-top: 6px;">
                            Invite members to join your camp team
                        </p>
                    </div>
                ` : _teamMembers.map(member => renderTeamMemberItem(member)).join('')}
            </div>
        `;

        // Bind invite button
        document.getElementById('invite-member-btn')?.addEventListener('click', () => {
            showInviteModal();
        });

        // Bind copy link buttons
        container.querySelectorAll('.member-copy-link-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                const url = btn.dataset.url;
                await copyToClipboard(url);
                showToast('Invite link copied!');
            });
        });

        // Bind send email buttons
        container.querySelectorAll('.member-send-email-btn').forEach(btn => {
            btn.addEventListener('click', async () => {
                const email = btn.dataset.email;
                const url = btn.dataset.url;
                const role = btn.dataset.role;
                await sendInviteEmail(email, url, role);
            });
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

    // =========================================================================
    // HELPER FUNCTIONS
    // =========================================================================

    /**
     * Copy text to clipboard
     */
    async function copyToClipboard(text) {
        try {
            await navigator.clipboard.writeText(text);
            return true;
        } catch (err) {
            // Fallback for older browsers
            const textarea = document.createElement('textarea');
            textarea.value = text;
            textarea.style.position = 'fixed';
            textarea.style.opacity = '0';
            document.body.appendChild(textarea);
            textarea.select();
            document.execCommand('copy');
            document.body.removeChild(textarea);
            return true;
        }
    }

    /**
     * Show a toast notification
     */
    function showToast(message, type = 'success') {
        let toast = document.getElementById('team-toast');
        if (!toast) {
            toast = document.createElement('div');
            toast.id = 'team-toast';
            toast.style.cssText = `
                position: fixed;
                bottom: 24px;
                left: 50%;
                transform: translateX(-50%) translateY(100px);
                padding: 12px 24px;
                border-radius: 10px;
                color: white;
                font-weight: 500;
                font-size: 0.9rem;
                z-index: 10001;
                transition: all 0.3s ease;
                box-shadow: 0 8px 24px rgba(0,0,0,0.2);
            `;
            document.body.appendChild(toast);
        }

        toast.style.background = type === 'success' ? '#10B981' : type === 'error' ? '#EF4444' : '#147D91';
        toast.textContent = message;
        
        // Animate in
        requestAnimationFrame(() => {
            toast.style.transform = 'translateX(-50%) translateY(0)';
        });

        // Hide after delay
        clearTimeout(toast._hideTimer);
        toast._hideTimer = setTimeout(() => {
            toast.style.transform = 'translateX(-50%) translateY(100px)';
        }, 3000);
    }

    /**
     * Open email client with pre-filled invite email (fallback)
     */
    function openInviteEmail(email, inviteUrl, role) {
        // Get camp name if available
        const campName = document.getElementById('campNameDisplay')?.textContent || 
                        document.querySelector('.welcome-title span')?.textContent ||
                        'our camp';

        const subject = encodeURIComponent(`You're invited to join ${campName} on Campistry`);
        
        const body = encodeURIComponent(
`Hi!

You've been invited to join ${campName} on Campistry as a ${role}.

Campistry is a camp management platform that helps us create and manage daily schedules, activities, and more.

Click the link below to accept your invitation:
${inviteUrl}

If you don't have a Campistry account yet, you'll be able to create one when you click the link.

Looking forward to working with you!

---
Sent via Campistry (campistry.org)`
        );

        window.open(`mailto:${email}?subject=${subject}&body=${body}`, '_blank');
    }

    /**
     * Send invite email via Resend (Edge Function)
     */
    async function sendInviteEmailViaResend(email, inviteUrl, role) {
        // Get camp name
        const campName = document.getElementById('campNameDisplay')?.textContent || 
                        document.querySelector('.welcome-title span')?.textContent ||
                        'Your Camp';

        try {
            // Get the Supabase URL from the client
            const supabaseUrl = window.supabase?.supabaseUrl || 
                               'https://bzqmhcumuarrbueqttfh.supabase.co';
            
            const response = await fetch(`${supabaseUrl}/functions/v1/send-invite-email`, {
                method: 'POST',
                headers: {
                    'Content-Type': 'application/json',
                    'Authorization': `Bearer ${(await window.supabase.auth.getSession()).data.session?.access_token}`,
                },
                body: JSON.stringify({
                    to: email,
                    inviteUrl: inviteUrl,
                    role: role,
                    campName: campName,
                }),
            });

            const data = await response.json();

            if (!response.ok) {
                throw new Error(data.error || 'Failed to send email');
            }

            return { success: true, data };
        } catch (error) {
            console.error('Error sending invite email:', error);
            return { success: false, error: error.message };
        }
    }

    /**
     * Smart email sender - tries Resend first, falls back to mailto
     */
    async function sendInviteEmail(email, inviteUrl, role, showFeedback = true) {
        if (showFeedback) {
            showToast('Sending invite email...', 'info');
        }

        // Try Resend first
        const result = await sendInviteEmailViaResend(email, inviteUrl, role);
        
        if (result.success) {
            if (showFeedback) {
                showToast(`Invite sent to ${email}!`, 'success');
            }
            return { success: true, method: 'resend' };
        }

        // If Resend fails, offer mailto fallback
        console.warn('Resend failed, offering mailto fallback:', result.error);
        
        if (showFeedback) {
            const useFallback = confirm(
                `Automatic email sending failed. Would you like to open your email client instead?\n\nError: ${result.error}`
            );
            
            if (useFallback) {
                openInviteEmail(email, inviteUrl, role);
                return { success: true, method: 'mailto' };
            }
        }

        return { success: false, error: result.error };
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

        // Generate invite URL for pending members
        const inviteUrl = isPending && member.invite_token 
            ? `${window.location.origin}/invite.html?token=${member.invite_token}`
            : null;

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
                    ${isPending && inviteUrl ? `
                        <button class="btn-icon member-copy-link-btn" data-url="${inviteUrl}" title="Copy Invite Link">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                            </svg>
                        </button>
                        <button class="btn-icon member-send-email-btn" data-email="${member.email}" data-url="${inviteUrl}" data-role="${roleName}" title="Send Invite Email">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"></path>
                                <polyline points="22,6 12,13 2,6"></polyline>
                            </svg>
                        </button>
                    ` : ''}
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
                            <option value="scheduler">Scheduler - Access to assigned divisions</option>
                            <option value="viewer">Viewer - View only, no editing</option>
                        </select>
                    </div>
                    
                    <div class="form-group" id="subdivisions-group" style="display: none;">
                        <label>Assign to Divisions</label>
                        <p style="font-size: 0.85rem; color: var(--slate-500); margin-bottom: 8px;">
                            Select which divisions this person can manage
                        </p>
                        ${subdivisions.length > 0 ? `
                            <div class="subdivision-checkboxes">
                                ${subdivisions.map(sub => `
                                    <label class="checkbox-item" style="border-left: 3px solid ${sub.color}; padding-left: 10px;">
                                        <input type="checkbox" name="subdivision" value="${sub.id}">
                                        <span>${sub.name}</span>
                                        <small style="color: var(--slate-400); margin-left: 8px;">
                                            ${sub.divisions?.join(', ') || 'No grades'}
                                        </small>
                                    </label>
                                `).join('')}
                            </div>
                        ` : `
                            <p style="color: var(--slate-500); font-style: italic;">
                                No divisions created yet. Create divisions in Campistry Me first to assign schedulers to specific divisions.
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

                // Show success with action buttons
                successEl.innerHTML = `
                    <div style="margin-bottom: 12px;">Invite created for <strong>${email}</strong></div>
                    <div style="display: flex; gap: 8px; flex-wrap: wrap;">
                        <button type="button" class="btn-action" id="copy-invite-link" style="
                            display: inline-flex;
                            align-items: center;
                            gap: 6px;
                            padding: 8px 16px;
                            background: #147D91;
                            color: white;
                            border: none;
                            border-radius: 6px;
                            font-size: 0.85rem;
                            font-weight: 500;
                            cursor: pointer;
                        ">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <rect x="9" y="9" width="13" height="13" rx="2" ry="2"></rect>
                                <path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"></path>
                            </svg>
                            Copy Link
                        </button>
                        <button type="button" class="btn-action" id="send-invite-email" style="
                            display: inline-flex;
                            align-items: center;
                            gap: 6px;
                            padding: 8px 16px;
                            background: #10B981;
                            color: white;
                            border: none;
                            border-radius: 6px;
                            font-size: 0.85rem;
                            font-weight: 500;
                            cursor: pointer;
                        ">
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
                                <path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"></path>
                                <polyline points="22,6 12,13 2,6"></polyline>
                            </svg>
                            Send Email
                        </button>
                    </div>
                    <div style="margin-top: 10px; font-size: 0.8rem; color: var(--slate-500);">
                        Or share this link directly: <br>
                        <input 
                            type="text" 
                            value="${result.inviteUrl}" 
                            readonly 
                            style="width: 100%; margin-top: 4px; padding: 6px 8px; font-size: 0.8rem; border: 1px solid var(--slate-200); border-radius: 4px;"
                            onclick="this.select()"
                        >
                    </div>
                `;

                // Bind the action buttons
                document.getElementById('copy-invite-link')?.addEventListener('click', async () => {
                    await copyToClipboard(result.inviteUrl);
                    showToast('Invite link copied!');
                });

                document.getElementById('send-invite-email')?.addEventListener('click', async () => {
                    const roleName = window.AccessControl?.getRoleDisplayName(role) || role;
                    await sendInviteEmail(email, result.inviteUrl, roleName);
                });

                // Refresh data
                await refreshData();
                
                // Don't auto-close - let user copy/send first
                // Add a done button
                const formActions = modal.querySelector('.form-actions');
                if (formActions) {
                    formActions.innerHTML = `
                        <button type="button" class="btn-primary" id="done-invite" style="width: 100%;">Done</button>
                    `;
                    document.getElementById('done-invite')?.addEventListener('click', () => {
                        closeModal();
                        const container = document.getElementById('team-card');
                        if (container) renderTeamCard(container);
                    });
                }

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
                        <label>Divisions</label>
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
                        ` : '<p style="color: var(--slate-500);">No divisions available</p>'}
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
                border-color: #147D91;
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
                background: rgba(20, 125, 145, 0.1);
                color: #147D91;
                border-radius: 999px;
                font-size: 0.85rem;
                font-weight: 500;
            }
            
            .tag-remove {
                background: none;
                border: none;
                color: #147D91;
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
                border-color: #147D91;
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
        copyToClipboard,
        showToast,
        openInviteEmail,
        sendInviteEmailViaResend,
        sendInviteEmail,
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

    console.log("[TeamUI] Team & Divisions UI v2.0 loaded");

})();
