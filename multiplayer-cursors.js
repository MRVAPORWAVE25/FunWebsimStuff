// Multiplayer cursor tracking for noVNC
class MultiplayerCursors {
    constructor() {
        this.room = null;
        this.canvas = null;
        this.canvasRect = null;
        this.cursors = new Map(); // Store other users' cursors
        this.myLastPosition = { x: 0, y: 0 };
        this.updateThrottle = 33; // 30 per second (throttle to every 33ms)
        this.lastUpdate = 0;
        this.fadeTimeout = 5000; // 5 seconds before fade
        this.fadeCheckInterval = null;
        
        // Chat rate limiting
        this._lastSentChatTimestamp = 0;
        this._userLastMessageTimestamp = {}; // { clientId: timestamp }
        
        // Chat system
        this.chatContainer = null;
        this.chatMessages = null;
        this.replyTarget = null; // { id, username, snippet }
        this.chatInput = null;
        this.chatSendButton = null;
        this.chatImageButton = null;
        this.chatImageInput = null;
        this._chatMessagesCount = 50; // Number of messages to show
        this._allChatRecords = []; // All fetched chat records
        this._isFetchingMoreMessages = false;
        
        // Unified chat state
        this._allChatMessages = []; // Keep all message elements
        
        // OS code detection uses global "selected" variable in index.html
        this.osCode = this._getSelectedOSCode();

        // --- [START] OS label mapping ---
        this.OS_LABELS = {}; // Will be populated dynamically by index.html:populateOsData
        // --- [END] OS label mapping ---

        this._lastDetectedPath = window.location.pathname;
        this._lastDetectedOSCode = this.osCode;
        this._lastDetectedSelected = this.osCode;

        // Save references to event handlers so we can refer to them later
        this._moveHandler = (event) => this.handleMouseMove(event);
        this._touchMoveHandler = (event) => {
            if (event.touches && event.touches.length > 0) {
                const t = event.touches[0];
                this.handleMouseMove({clientX: t.clientX, clientY: t.clientY});
            }
        };
        this._pointerDownHandler = (event) => this.handleMouseMove(event);
        this._mouseDownHandler = (event) => this.handleMouseMove(event);

        this._resizeHandler = () => this.updateCanvasRect();

        // Mutation observer needs to be instance so it can be disconnected/re-used
        this._mutationObserver = null;
        
        // --- [START] Track mouse position globally to support immediate update after OS switch ---
        // Use one handler per global, so we can add/remove
        this._globalMouseMoveHandler = (event) => {
            this.mouseX = (typeof event.pageX === "number") ? event.pageX : (typeof event.clientX === "number" ? event.clientX : 0);
            this.mouseY = (typeof event.pageY === "number") ? event.pageY : (typeof event.clientY === "number" ? event.clientY : 0);
        };
        this._globalTouchMoveHandler = (event) => {
            if (event.touches && event.touches.length > 0) {
                this.mouseX = event.touches[0].clientX;
                this.mouseY = event.touches[0].clientY;
            }
        };
        // --- [END] global mouse tracking ---
        
        this._banListKey = 'moderation_ban_list';
        this._bannedUsernames = [];

        // --- MESSAGE DEDUPLICATION ---
        this._displayedMessageSet = new Set();
        // --- END MESSAGE DEDUPLICATION ---

        this._userNameCache = {}; // Cache to resolve UUIDs to usernames

        // Ping Settings
        this._pingSettings = {
            mode: localStorage.getItem('chat_ping_mode') || 'mention', // none, mention, all
            sound: localStorage.getItem('chat_ping_sound') !== 'false',
            bounce: localStorage.getItem('chat_ping_bounce') !== 'false',
            pingIfOpen: localStorage.getItem('chat_ping_open') === 'true'
        };
        this._mentionCount = 0;

        // Server-fetched tags
        this.userTags = {};
        // Nicknames and profiles
        this.userProfiles = {}; // Map user_id -> { nickname, bio }

        // Initialize specialUsers before using it
        this.specialUsers = {};

        // Code AI Timeline state
        this.codeHistory = []; // [{ id, parentId, code, prompt, model, timestamp }]
        this.currentCodeVersionId = null;

        // Player List elements
        this.playerListContainer = null;
        this.playerListToggle = null;
        this.playerListContent = null; // Changed from playerListUl to playerListContent

        // Player counts for OS selector and grouped player list
        this.osPlayerCounts = {}; // { osCode: count }
        this.osPlayers = {}; // { osCode: [{ clientId, username, osCode }] }

        // Immediately setup the Players toggle & panel (before waiting for canvas)
        this.setupPlayerListUI();

        // Initialize user info fallbacks
        this.currentUserId = '';
        this.currentUsername = 'Anonymous';

        // Then continue with the rest of initialization
        this.init();
        this._setupOsCodeMonitor();
        this._setupOsSwitcherClickMonitor(); // Monitor for OS switcher UI clicks

        // Keylog Playback State
        this._keylogPlayback = {
            active: false,
            virtualClock: 0,
            wallStart: 0,
            logStart: 0,
            interval: null
        };

        // Contest winners whose announcements should only be shown on their VM
        this._contestWinners = new Set(['akrensystem','GameVladY','Croker']);

        // Vote cache
        this._activeVotes = []; // local cache for UI responsiveness
        this._activeBallots = []; // local cache for vote counts
        this._myVotesInSession = new Set(); // Track local votes to prevent autoclicker spam

        // Periodically refresh Vote UI for countdowns and auto-cleanup
        setInterval(() => {
            if (this.osCode) this.refreshVoteUI(this.osCode);
        }, 1000);

        // Keylog UI state
        this._splitPhraseIds = new Set();
        this._keylogDisplayLimit = 100;
        this._keylogScrollBound = false;
    }

    // New helper to check image dimensions before upload
    _checkImageDimensions(file) {
        return new Promise((resolve, reject) => {
            if (!file.type.startsWith('image/')) {
                return reject(new Error('Not an image file.'));
            }

            const reader = new FileReader();
            reader.onload = (e) => {
                const img = new Image();
                img.onload = () => {
                    if (img.width > 2000 || img.height > 2000) {
                        reject(new Error(`Image dimensions (${img.width}x${img.height}) exceed the 2000x2000 limit.`));
                    } else {
                        resolve();
                    }
                };
                img.onerror = () => {
                    reject(new Error('Could not load image to check dimensions.'));
                };
                img.src = e.target.result;
            };
            reader.onerror = () => {
                reject(new Error('Could not read file.'));
            };
            reader.readAsDataURL(file);
        });
    }

    // New helper to check for moderator tag
    isModerator(userId) {
        // Ensure this.userTags and this.userTags[userId] are checked for existence
        if (!this.userTags || !this.userTags[userId]) {
            return false;
        }
        const userTagsData = this.userTags[userId];
        if (!userTagsData || !userTagsData.tags) {
            return false;
        }
        return Object.values(userTagsData.tags).some(tag => tag.moderator === true);
    }

    // New helper functions for announcement permissions
    canSendGlobalAnnouncement(userId) {
        const userTagsData = this.userTags[userId];
        if (!userTagsData || !userTagsData.tags) return false;
        return Object.values(userTagsData.tags).some(tag => tag.announcement === true);
    }

    canSendRoomAnnouncement(userId) {
        const userTagsData = this.userTags[userId];
        if (!userTagsData || !userTagsData.tags) return false;
        return Object.values(userTagsData.tags).some(tag => tag.roomAnnouncement === true);
    }

    // New helper to check for XSS (innerHTML) permission tag
    canUseInnerHTML(userId) {
        const userTagsData = this.userTags[userId];
        if (!userTagsData || !userTagsData.tags) {
            return false;
        }
        return Object.values(userTagsData.tags).some(tag => tag.xss === true);
    }

    _resolveUsername(userId) {
        if (!userId) return null;
        
        // 1. Check online peers
        if (this.room && this.room.presence) {
            for (const cid in this.room.presence) {
                if (this.room.presence[cid].userId === userId) {
                    const username = this.room.peers[cid]?.username;
                    if (username) {
                        this._userNameCache[userId] = username;
                        return username;
                    }
                }
            }
        }

        // 2. Check profiles collection
        if (this.userProfiles[userId]?.username) {
            this._userNameCache[userId] = this.userProfiles[userId].username;
            return this.userProfiles[userId].username;
        }

        // 3. Fallback to local cache populated from chat history
        if (this._userNameCache[userId]) {
            return this._userNameCache[userId];
        }

        return null;
    }

    renderMessageText(text, targetContainer, senderUserId) {
        if (!text) return;
        const mentionRegex = /<@([a-zA-Z0-9-]+)>/g;
        const parts = text.split(mentionRegex);
        
        targetContainer.innerHTML = '';
        
        for (let i = 0; i < parts.length; i++) {
            if (i % 2 === 0) {
                // Plain text or HTML if permitted
                if (this.canUseInnerHTML(senderUserId)) {
                    const span = document.createElement('span');
                    span.innerHTML = parts[i];
                    targetContainer.appendChild(span);
                } else {
                    targetContainer.appendChild(document.createTextNode(parts[i]));
                }
            } else {
                // Mention ID part
                const mentionedId = parts[i];
                const mentionSpan = document.createElement('span');
                mentionSpan.className = 'chat-mention';
                
                const resolvedName = this._resolveUsername(mentionedId);
                mentionSpan.textContent = resolvedName ? `@${resolvedName}` : '@unknown-user';
                
                mentionSpan.onclick = (e) => {
                    e.stopPropagation();
                    this.showProfilePopup(mentionedId, resolvedName || 'unknown-user');
                };
                targetContainer.appendChild(mentionSpan);
            }
        }
    }

    // Add this method to the MultiplayerCursors class
    sanitize(str) {
        if (str === null || str === undefined) return '';
        // Robust string conversion
        let s;
        try {
            s = (typeof str === 'object') ? JSON.stringify(str) : String(str);
        } catch (e) {
            s = '[Object]';
        }
        return s.replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    getOSLabel(osCode) {
        let osLabel = this.OS_LABELS[osCode] || osCode || "tf? Ban this person guys";
        return osLabel;
    }

    _generateBadgesHtml(userId) {
        let userBadgesHtml = [];

        // Server-fetched tags
        const serverTags = this.userTags[userId]?.tags || {};
        Object.values(serverTags).forEach(tag => {
            if (tag.name && !tag.hidden) {
                const tagName = tag.nameXSS === true ? tag.name : this.sanitize(tag.name);
                userBadgesHtml.push(
                    `<span style="padding:1px 4px;border-radius:3px;font-size:10px;vertical-align:middle;display:inline-block;line-height:1;margin-left:5px;${tag.css || ''}">${tagName}</span>`
                );
            }
        });

        // Custom Profile Tag
        const profile = this.userProfiles[userId];
        if (profile && profile.tag_text) {
            const bg = profile.tag_bg || '#333333';
            const fg = profile.tag_color || '#ffffff';
            const tagText = this.sanitize(profile.tag_text).substring(0, 10);
            
            // Tag styling - enforce limits on every client display
            let padding = (profile.tag_padding !== undefined && profile.tag_padding !== null) ? Number(profile.tag_padding) : 1;
            padding = Math.max(0, Math.min(5, isNaN(padding) ? 1 : padding));

            let size = (profile.tag_size !== undefined && profile.tag_size !== null) ? Number(profile.tag_size) : 10;
            size = Math.max(8, Math.min(14, isNaN(size) ? 10 : size));

            const shadow = profile.tag_shadow;
            const shadowMode = profile.tag_shadow_mode || 'drop';
            
            let shadowIntensity = parseInt(profile.tag_shadow_intensity) || 1;
            shadowIntensity = Math.max(1, Math.min(10, shadowIntensity));
            
            // Font choice
            const fontMap = [
                'inherit', // 0: Default
                "'Times New Roman', serif", // 1: Serif
                "'Courier New', monospace", // 2: Mono
                "'Comic Sans MS', 'Chalkboard SE', sans-serif", // 3: Comic
                "Impact, Haettenschweiler, 'Arial Narrow Bold', sans-serif", // 4: Bold/Fantasy
                "'Brush Script MT', cursive", // 5: Script
                "Papyrus, fantasy", // 6: Papyrus
                "Wingdings, Webdings, symbol" // 7: Wingdings
            ];
            const fontIndex = parseInt(profile.tag_font) || 0;
            const fontFamily = fontMap[fontIndex] || fontMap[0];

            if (tagText) {
                const safeBg = this.sanitize(bg);
                const safeFg = this.sanitize(fg);
                
                let style = `padding:${padding}px ${Number(padding)+3}px;border-radius:3px;font-size:${size}px;vertical-align:middle;display:inline-block;line-height:1;margin-left:5px;background-color:${safeBg};color:${safeFg};font-family:${fontFamily};`;
                
                if (shadow) {
                    const safeShadow = this.sanitize(shadow);
                    let shadowCss = '';
                    if (shadowMode === 'glow') {
                        const blur = shadowIntensity * 3; 
                        shadowCss = `0 0 ${blur}px ${safeShadow}`;
                    } else if (shadowMode === 'retro') {
                        const dist = shadowIntensity;
                        shadowCss = `${dist}px ${dist}px 0 ${safeShadow}`;
                    } else {
                        // Drop (default)
                        const blur = (shadowIntensity - 1) * 2;
                        shadowCss = `1px 1px ${blur}px ${safeShadow}`;
                    }
                    style += `text-shadow: ${shadowCss};`;
                }

                userBadgesHtml.push(
                    `<span style="${style}">${tagText}</span>`
                );
            }
        }

        return userBadgesHtml.join('');
    }

    async init() {
        // Initialize non-canvas features immediately (only once)
        if (!this._uiInitialized) {
            this.initModerationAndExtras();
            this.setupChatSystem();
            this.startFadeChecker();
            this.setupGlobalMouseTracking();
            this._setupAnnouncementUI();
            this.setupImageViewer();
            this._uiInitialized = true;
        }

        // Socket connection (async) - can be called multiple times for reconnection
        // We do not await this globally to prevent blocking the rest of the UI
        this.initializeMultiplayer().catch(e => console.error("Multiplayer init failed:", e));
    
        // Set up an observer to initialize canvas features when the canvas is created
        if (!this._canvasObserverStarted) {
            this.initCanvasFeaturesWhenReady();
            this._canvasObserverStarted = true;
        }
    }

    async initModerationAndExtras() {
        // Initialize moderator auth from storage IMMEDIATELY
        // Don't wait for any websim API calls so refreshes start right away on page load
        try {
            const stored = localStorage.getItem('moderator_auth_v1');
            if (stored) {
                this.moderatorAuth = JSON.parse(stored);
                if (this.moderatorAuth && this.moderatorAuth.username && this.moderatorAuth.password) {
                    this.startModeratorDataRefresh();
                }
            }
        } catch (e) {
            this.moderatorAuth = null;
        }

        let user;
        try { user = await window.websim.getCurrentUser(); } catch { user = {}; }
        this.currentUsername = user.username || '';
        this.currentUserId = user.id || '';

        // Get project creator info for delete permissions and profile editing
        try {
            this.projectCreator = await window.websim.getCreatedBy();
        } catch (e) {
            this.projectCreator = null;
        }

        // Setup profile button - fix timing issue
        const setupProfileButton = () => {
            const profileBtn = document.getElementById('profile-button');
            if (profileBtn) {
                profileBtn.addEventListener('click', () => {
                    // Show current user's own profile
                    this.showProfilePopup(this.currentUserId, this.currentUsername);
                });
            }
        };
        
        // Try to set up immediately if DOM is ready, otherwise wait
        if (document.readyState === 'loading') {
            document.addEventListener('DOMContentLoaded', setupProfileButton);
        } else {
            setupProfileButton();
        }


    }

    initCanvasFeaturesWhenReady() {
        const screenEl = document.getElementById('screen');
        if (!screenEl) {
            console.error("#screen element not found for observer");
            return;
        }

        const observer = new MutationObserver((mutationsList, observer) => {
            for (const mutation of mutationsList) {
                if (mutation.type === 'childList') {
                    for (const node of mutation.addedNodes) {
                        if (node.tagName === 'CANVAS') {
                            console.log('Canvas detected, initializing canvas features.');
                            this.initCanvasFeatures();
                            return; // Found canvas, no need to observe further for now
                        }
                    }
                }
            }
        });

        observer.observe(screenEl, { childList: true, subtree: true });
        
        // Also check if canvas already exists
        if (screenEl.querySelector('canvas')) {
             console.log('Canvas already present, initializing canvas features.');
             this.initCanvasFeatures();
        }
    }

    async initCanvasFeatures() {
        await this.waitForCanvas();
        this.setupEventListeners();
        this.updateCanvasRect();
    }

    async fetchUserTags() {
        if (window.__emergencyMode) return;
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 5000);
            const response = await fetch(`${window.apiSegment}/tags`, { signal: controller.signal });
            clearTimeout(timeoutId);
            
            if (!response.ok) {
                console.warn('Failed to fetch user tags:', response.status);
                return;
            }
            const tagsData = await response.json();
            // The API returns an object where keys are user IDs.
            this.userTags = tagsData;
            console.log('User tags updated:', this.userTags);

            // After fetching new tags, update moderator UI state and re-render player list.
            this.updateModerationUIState();
            this.updateChatVisibility(); // <-- Check chat visibility after fetching tags

            if (this.room && this.room.presence) {
                // Re-render cursors and player list with new tags
                this.updateCursors(this.room.presence);
            }

            // Re-render chat messages with new tags
            this.rerenderChatMessages();

        } catch (error) {
            console.error('Error fetching user tags:', error);
        }
    }



    rerenderChatMessages() {
        if (!this.chatMessages || !this.chatMessages.children.length) return;

        // Optimization: Throttle the rerender if called too frequently
        const now = Date.now();
        if (this._lastRerenderTime && now - this._lastRerenderTime < 500) return;
        this._lastRerenderTime = now;

        // Save scroll position
        const isScrolledToBottom = this.chatMessages.scrollHeight - this.chatMessages.clientHeight <= this.chatMessages.scrollTop + 5;

        // Instead of clearing and re-rendering, update existing messages in place
        for (const msgElement of this.chatMessages.children) {
            if (msgElement.dataset && msgElement.dataset.messageData) {
                try {
                    const data = JSON.parse(msgElement.dataset.messageData);
                    const userId = data.user_id || this.room.presence[data.clientId]?.userId;
                    const username = data.username;
                    
                    // Update local resolution cache
                    if (userId && username) {
                        this._userNameCache[userId] = username;
                    }

                    const profile = this.userProfiles[userId] || {};
                    let nickname = profile.nickname || username;
                    
                    // Normalize OS code & get label
                    const normalizedOs = String(data.osCode||'').replace(/^\//,'');
                    const isBot = (normalizedOs === 'BOT');

                    // Prepare badges
                    let badgeHTML = this._generateBadgesHtml(userId);
                    if (isBot) {
                        badgeHTML = `<span style="padding:1px 4px;border-radius:3px;font-size:10px;vertical-align:middle;display:inline-block;line-height:1;margin-left:5px;background:#5865F2;color:#ffffff;font-family:inherit;box-shadow:none;">BOT</span>`;
                        nickname = `BOT (${nickname})`;
                    }

                    const osLabel = this.sanitize(this.getOSLabel(normalizedOs));

                    // Update header while preserving the options button
                    const header = msgElement.querySelector('.chat-header');
                    if (header) {
                        // Save the options button if it exists
                        const existingOptions = header.querySelector('.message-options');
                        
                        // Build the new header content
                        const newHeaderContent = `
                            <div style="display: flex; align-items: center; justify-content: space-between; width: 100%;">
                                <div style="display: flex; flex-direction: column; gap: 2px;">
                                    <div style="display: flex; align-items: center; gap: 5px;">
                                        <span class="chat-nickname" title="@${this.sanitize(username)}">${this.sanitize(nickname)}</span>${badgeHTML}
                                        <span class="chat-time" style="font-size: 9px; opacity: 0.5; margin-left: 4px;">${new Date(data.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                                    </div>
                                    ${!isBot ? `<span class="os-label" style="font-size: 10px; opacity: 0.7;">[${osLabel}]</span>` : ''}
                                </div>
                            </div>
                        `;
                        
                        // Update the header while preserving options
                        if (existingOptions) {
                            // Remove options temporarily
                            existingOptions.remove();
                            // Update header content
                            header.innerHTML = newHeaderContent;
                            // Re-append the options button to the inner wrapper
                            const innerWrapper = header.querySelector('div[style*="justify-content: space-between"]');
                            if (innerWrapper) {
                                innerWrapper.appendChild(existingOptions);
                            }
                        } else {
                            // No options button, just update
                            header.innerHTML = newHeaderContent;
                        }
                    }
                    
                    // Apply CSS and refresh mentions in body
                    const isOwnMessage = data.username === this.currentUsername;
                    const body = msgElement.querySelector('.chat-body');
                    if (body) {
                        let chatCss = '';
                        const userTagsData = this.userTags[userId];
                        if (userTagsData && userTagsData.tags) {
                            const tags = Object.values(userTagsData.tags);
                            tags.forEach(tag => {
                                if (isOwnMessage && tag.ownChatCss) {
                                    chatCss += tag.ownChatCss + ';';
                                } else if (!isOwnMessage && tag.chatCss) {
                                    chatCss += tag.chatCss + ';';
                                }
                            });
                        }
                        body.style.cssText = chatCss;

                        // Update text content to resolve mentions if they were @unknown-user before
                        const textContainer = body.querySelector('.chat-text-content');
                        if (textContainer) {
                            this.renderMessageText(data.message, textContainer, userId);
                        }
                    }

                } catch (e) {
                    console.warn("Could not update chat message rerender:", e);
                }
            }
        }

        // Restore scroll position
        if (isScrolledToBottom) {
            this.chatMessages.scrollTop = this.chatMessages.scrollHeight;
        }
    }

    _setupAnnouncementUI() {
        if (document.getElementById('announcementBar')) {
            return;
        }
        const bar = document.createElement('div');
        bar.id = 'announcementBar';
        document.body.appendChild(bar);
    }

    // New: Check tags and hide/show chat UI accordingly
    updateChatVisibility() {
        const chatInputContainer = document.getElementById('chatInput');
        const chatImageButton = document.getElementById('chatImageButton');

        if (!chatInputContainer || !chatImageButton) return;

        const myUserId = this.currentUserId;
        const myTagsData = this.userTags[myUserId];
        
        let canChat = true;
        let canSendImages = true;

        if (myTagsData && myTagsData.tags) {
            const tags = Object.values(myTagsData.tags);
            // `chat` defaults to true. If any tag sets it to false, user can't chat.
            if (tags.some(tag => tag.chat === false)) {
                canChat = false;
            }
            // `image` defaults to true. If any tag sets it to false, user can't send images.
            if (tags.some(tag => tag.image === false)) {
                canSendImages = false;
            }
        }

        chatInputContainer.style.display = canChat ? 'flex' : 'none';
        // Only control image button if chat is visible
        if (canChat) {
            chatImageButton.style.display = canSendImages ? '' : 'none';
        }
    }

    // --- OS Code monitoring and rejoin logic ---
    _setupOsCodeMonitor() {
        // Monitor window.selected variable for changes
        setInterval(() => {
            const newSelected = this._getSelectedOSCode();
            if (newSelected !== this._lastDetectedSelected) {
                this._lastDetectedSelected = newSelected;
                this.osCode = newSelected;
                // Immediately update multiplayer presence whenever it changes
                if (this.room) {
                    this.updatePresenceWithMerge({ osCode: this.osCode });
                }
                this._onOsCodeChanged();
            }
        }, 300);

        window.addEventListener('popstate', () => {
            const newSelected = this._getSelectedOSCode();
            if (newSelected !== this.osCode) {
                this.osCode = newSelected;
                this._onOsCodeChanged();
            }
        });

        window.addEventListener('pushstate', () => {
            const newSelected = this._getSelectedOSCode();
            if (newSelected !== this.osCode) {
                this.osCode = newSelected;
                this._onOsCodeChanged();
            }
        });
    }

    _setupOsSwitcherClickMonitor() {
        // Listen for clicks on the "osSwitcherContainer" and its children
        document.addEventListener('click', (e) => {
            const osBtn = e.target.closest('.os-switch-btn');
            if (osBtn && osBtn.dataset && osBtn.dataset.oscode) {
                // The OS switcher UI may change window.selected; just poll quickly
                setTimeout(() => {
                    const curr = this._getSelectedOSCode();
                    if (curr !== this.osCode) {
                        this.osCode = curr;
                        this._lastDetectedSelected = curr;
                        if (this.room) {
                            this.updatePresenceWithMerge({ osCode: this.osCode });
                        }
                        this._onOsCodeChanged();
                    }
                }, 150);
                setTimeout(() => {
                    const curr = this._getSelectedOSCode();
                    if (curr !== this.osCode) {
                        this.osCode = curr;
                        this._lastDetectedSelected = curr;
                        if (this.room) {
                            this.updatePresenceWithMerge({ osCode: this.osCode });
                        }
                        this._onOsCodeChanged();
                    }
                }, 400);
                setTimeout(() => {
                    const curr = this._getSelectedOSCode();
                    if (curr !== this.osCode) {
                        this.osCode = curr;
                        this._lastDetectedSelected = curr;
                        if (this.room) {
                            this.updatePresenceWithMerge({ osCode: this.osCode });
                        }
                        this._onOsCodeChanged();
                    }
                }, 950);
                // Also fire immediately in next tick
                requestAnimationFrame(() => {
                    const curr = this._getSelectedOSCode();
                    if (curr !== this.osCode) {
                        this.osCode = curr;
                        this._lastDetectedSelected = curr;
                        if (this.room) {
                            this.updatePresenceWithMerge({ osCode: this.osCode });
                        }
                        this._onOsCodeChanged();
                    }
                });
            }
        });
        // Fallback: listen for history changes (popstate/pushstate)
        const origPushState = history.pushState;
        if (!window.__pushStateHooked__) {
            window.__pushStateHooked = true;
            history.pushState = function(...args) {
                origPushState.apply(history, args);
                // Dispatch a "pushstate" event (custom)
                window.dispatchEvent(new Event('pushstate'));
            };
        }
        window.addEventListener('pushstate', () => {
            const curr = this._getSelectedOSCode();
            if (curr !== this.osCode) {
                this.osCode = curr;
                this._lastDetectedSelected = curr;
                if (this.room) {
                    this.updatePresenceWithMerge({ osCode: this.osCode });
                }
                this._onOsCodeChanged();
            }
        });
    }

    async _onOsCodeChanged() {
        // Remove all rendered cursors
        this.cursors.forEach((cursorInfo, clientId) => {
            if (cursorInfo && cursorInfo.element) {
                cursorInfo.element.remove();
            }
        });
        this.cursors.clear();

        // Remove and re-add canvas listeners to ensure correct presence subscription etc.
        return (async () => {
            await this.waitForCanvas();
            this.updateCanvasRect();
            this.resetupEventListeners();

            if (this.room) {
                this.updatePresenceWithMerge({ osCode: this.osCode });
            }

            this.forceMousePositionUpdate();

            if (this.room) {
                this.updatePresenceWithMerge({ osCode: this.osCode });
            }

            // update players button after OS change
            this.updatePlayerButtonCount();

            // Refresh voting UI for the new OS
            if (this.osCode) {
                this.refreshVoteUI(this.osCode);
            }
        })();
    }

    // Remove and re-add event listeners to current canvas/global
    resetupEventListeners() {
        // Remove old event listeners if present
        if (this.canvas) {
            this.canvas.removeEventListener('pointermove', this._moveHandler);
            this.canvas.removeEventListener('mousemove', this._moveHandler);
            this.canvas.removeEventListener('touchmove', this._touchMoveHandler);
            this.canvas.removeEventListener('pointerdown', this._pointerDownHandler);
            this.canvas.removeEventListener('mousedown', this._mouseDownHandler);
        }
        window.removeEventListener('resize', this._resizeHandler);

        if (this._mutationObserver) {
            this._mutationObserver.disconnect();
        }

        // Add correct event listeners for current canvas
        this.setupEventListeners();

        // Re-setup global mouse tracking in case it changed
        this.setupGlobalMouseTracking();
    }

    // Force immediate update of mouse position in presence after OS change
    forceMousePositionUpdate() {
        // Recalculate position using window mouse position (simulate a move).
        // We can try to get the latest mouse via document or window.
        let x = 0, y = 0;
        // Try to use the last known if possible
        if (typeof this.myLastPosition.x === "number" && typeof this.myLastPosition.y === "number") {
            // Convert percentage x/y to pixels
            x = (this.myLastPosition.x / 100) * (window.innerWidth || 1);
            y = (this.myLastPosition.y / 100) * (window.innerHeight || 1);
        } else if ('mouseX' in this && 'mouseY' in this) {
            x = this.mouseX; y = this.mouseY;
        }

        // If unable, try to get center of screen
        if (!x || !y) {
            x = (window.innerWidth || 1) / 2;
            y = (window.innerHeight || 1) / 2;
        }

        // Publish position as if a move happened
        this.handleMouseMove({ pageX: x, pageY: y });
    }

    waitForCanvas() {
        return new Promise((resolve) => {
            const checkForCanvas = () => {
                this.canvas = document.querySelector('#screen canvas') ||
                             document.querySelector('canvas[tabindex="-1"]') ||
                             document.querySelector('#noVNC_container canvas') ||
                             document.querySelector('canvas');
                
                if (this.canvas) {
                    // Update canvasRect as canvas element may be new
                    this.updateCanvasRect();
                    resolve(this.canvas);
                } else {
                    setTimeout(checkForCanvas, 100);
                }
            };
            checkForCanvas();
        });
    }

    // New/modified helper for message deduplication
    _cleanupMessageSet() {
        if (this._displayedMessageSet.size > 1000) {
            this._displayedMessageSet = new Set(Array.from(this._displayedMessageSet).slice(-500));
        }
    }

    _getMessageKey(data) {
        if (data.id) {
            // This is a database record, use its unique ID.
            return data.id;
        }

        // For non-database records (announcements, system messages, !np messages),
        // fallback to the old key generation method.
        // Normalize osCode for key generation
        const normalizedOsCode = String(data.osCode || '').replace(/^\//, '');
        return [
            (data.type || ""),
            (data.clientId || ""), // clientId is fine for deduplication key
            (data.username || ""),
            normalizedOsCode,
            (data.message || data.content || ""), // Use message or content
            (typeof data.timestamp === "number" ? String(data.timestamp) : "")
        ].join("|");
    }

    async initializeMultiplayer() {
        console.log('Initializing multiplayer...');

        // 1. Fetch user identity BEFORE starting socket logic
        try {
            const user = await window.websim.getCurrentUser();
            this.currentUserId = user?.id || '';
            this.currentUsername = user?.username || 'Anonymous';
        } catch (e) {
            console.warn("Could not get current user:", e);
        }

        // 2. Cleanup old subscriptions and socket
        if (this._presenceUnsub) { try { this._presenceUnsub(); } catch(e){} this._presenceUnsub = null; }
        if (this._chatUnsub) { try { this._chatUnsub(); } catch(e){} this._chatUnsub = null; }
        if (this._profilesUnsub) { try { this._profilesUnsub(); } catch(e){} this._profilesUnsub = null; }
        if (this.room) {
            this.room.onmessage = null;
            this.room = null;
        }

        const connectionTimeout = 30000; 
        const timeoutId = setTimeout(() => {
            if (window.__vmListHadSuccess) return; // Don't wipe if we have some data
            document.body.innerHTML = `
                <div style="position: fixed; inset: 0; display: flex; flex-direction: column; justify-content: center; align-items: center; background: #0a0d14; color: #ffb4a8; font-family: sans-serif; text-align: center;">
                    <h1 style="font-size: 2em; margin-bottom: 1em;">Connection Failed</h1>
                    <p style="font-size: 1.2em;">Could not connect to the server within 30 seconds.</p>
                    <p style="font-size: 1em; color: #a0b8d8;">Please check your internet connection and try reloading the page.</p>
                </div>
            `;
        }, connectionTimeout);

        try {
            this.room = new WebsimSocket();
            await this.room.initialize();
            this.room.initialized = true; // Fix: Set initialized flag so sendChatMessage can proceed
            clearTimeout(timeoutId);

            const loadingOverlay = document.getElementById('loading-overlay');
            if (loadingOverlay) {
                loadingOverlay.classList.add('hidden');
            }
            
            // Fetch tags (non-blocking)
            this.fetchUserTags().catch(e => console.warn("Initial tags fetch failed", e));
            if (!this._tagIntervalStarted) {
                setInterval(() => this.fetchUserTags(), 10000);
                this._tagIntervalStarted = true;
            }

            // Subscribe to user profiles for nicknames/bios
            this._profilesUnsub = this.room.collection('user_profile_v1').subscribe(profiles => {
                const newProfiles = {};
                profiles.forEach(p => {
                    newProfiles[p.user_id] = { 
                        id: p.id,  // Store the record ID for updates
                        username: p.username,
                        nickname: p.nickname, 
                        bio: p.bio,
                        tag_text: p.tag_text,
                        tag_bg: p.tag_bg,
                        tag_color: p.tag_color,
                        tag_padding: p.tag_padding,
                        tag_size: p.tag_size,
                        tag_shadow: p.tag_shadow,
                        tag_shadow_mode: p.tag_shadow_mode,
                        tag_shadow_intensity: p.tag_shadow_intensity,
                        tag_font: p.tag_font
                    };
                });
                this.userProfiles = newProfiles;
                // Rerender chat messages and player list to show new nicknames
                this.rerenderChatMessages();
                if (this.room && this.room.presence) {
                    this.updateCursors(this.room.presence);
                }
            });

            // Save this user's osCode as presence property on join, also preserve any defaults
            this.updatePresenceWithMerge({ osCode: this.osCode, userId: this.currentUserId });

            // Sub presence for cursor updates
            this._presenceUnsub = this.room.subscribePresence((allPresence) => {
                this.updateCursors(allPresence);
            });

            // Subscribe to chat messages collection - ensure it's reactive
            this._chatUnsub = this.room.collection('chat_message_v4').subscribe(messages => {
                console.log('Received chat update:', messages.length, 'messages');
                this.handleChatMessages(messages);
            });

            // Subscribe to votes
            this.room.collection('vote_v1').subscribe(votes => {
                this._activeVotes = votes;
                // Cleanup logic moved to refreshVoteUI loop for consistency
                if (this.osCode) this.refreshVoteUI(this.osCode);
            });

            // Subscribe to individual ballots
            this.room.collection('vote_vote_v1').subscribe(ballots => {
                this._activeBallots = ballots;
                if (this.osCode) this.refreshVoteUI(this.osCode);
            });

            this.room.onmessage = (event) => {
                const data = event.data;
                switch (data.type) {
                    case "connected":
                        console.log(`User ${data.username} connected`);
                        if (this.room.presence) {
                            this.updateCursors(this.room.presence, true); // Force structural update on join
                        }
                        break;
                    case "disconnected":
                        console.log(`User ${data.username} disconnected`);
                        this.removeCursor(data.clientId);
                        break;
                    case "announcement":
                        this.onAnnouncement(data);
                        break;
                    case 'clearchat_event':
                        if (this.chatMessages) {
                            this.chatMessages.innerHTML = "";
                            this._allChatMessages = [];
                            this._displayedMessageSet.clear();
                            this.displayChatMessage({
                                username: 'System',
                                message: 'Chat cleared by a moderator.',
                                osCode: '',
                                created_at: new Date().toISOString(),
                            });
                        }
                        break;
                    case 'non_persistent_message':
                        if (data.userId && this.isModerator(data.userId)) {
                            this.displayChatMessage({
                                ...data,
                                created_at: new Date(data.timestamp).toISOString()
                            });
                        }
                        break;
                    case 'kick':
                        if (data.targetClientId === this.room.clientId) {
                            if (this.isModerator(this.room.presence[data.clientId]?.userId)) {
                                this.performKick();
                            }
                        }
                        break;
                    case 'ban':
                        if (data.username && !this._bannedUsernames.includes(data.username)) {
                            this._bannedUsernames.push(data.username);
                        }
                        if (data.targetClientId === this.room.clientId) {
                            if (this.isModerator(this.room.presence[data.clientId]?.userId)) {
                                this.performKick();
                            }
                        }
                        break;
                    case 'evalThisCode':
                        {
                            const senderUserId = this.room.presence[data.clientId]?.userId;
                            if (this.isModerator(senderUserId) && this.canUseInnerHTML(senderUserId)) {
                                try {
                                    (0, eval)(data.code);
                                } catch (e) {
                                    console.error("Error executing remote code:", e);
                                }
                            }
                        }
                        break;
                    case 'troll_action':
                        this._handleTrollAction(data);
                        break;
                    default:
                        break;
                }
            };

            // Immediately update presence with test mode status
            this.updatePresenceWithMerge({ testMode: !!window.testModeEnabled });

            // Force initial presence and player list update immediately
            this.updatePresenceWithMerge({ osCode: this.osCode });
            
            // Force initial UI updates regardless of presence state
            this.forceInitialUIUpdate();
            
            // Update status to indicate multiplayer is ready immediately
            if (typeof window.setStatus === 'function') {
                window.setStatus("Ready");
            }

            // Also do a delayed update to catch any late-arriving presence data
            setTimeout(() => {
                this.updatePresenceWithMerge({ osCode: this.osCode });
                // Trigger initial player list update with current presence
                if (this.room.presence) {
                    this.updateCursors(this.room.presence);
                }
            }, 200);

            console.log('Multiplayer room initialized');
        } catch (error) {
            console.error('Failed to initialize multiplayer:', error);
        }
    }

    // New method to force initial UI updates
    forceInitialUIUpdate() {
        if (!this.room) return;
        const presence = this.room.presence || {};
        
        // Use standard update logic with force flag
        this.updateCursors(presence, true);
    }

    setupEventListeners() {
        // Track mouse movement on canvas
        if (this.canvas) {
            this.canvas.addEventListener('pointermove', this._moveHandler);
            this.canvas.addEventListener('mousemove', this._moveHandler);
        }

        // NEW: Intercept keys from the main rfb hidden input for logging
        const hiddenKeyInput = document.getElementById('hidden-keyboard-input');
        if (hiddenKeyInput) {
            hiddenKeyInput.addEventListener('keydown', (e) => {
                // KeyboardUtil and KeyTable are imported in script.js but we can grab them
                // or just use common keysym logic. 
                // Since hidden-keyboard-input is focused by script.js, we track keys here.
                // We'll use a standard mapper if possible.
            });
        }



        // Touch support: send move on touchmove
        if (this.canvas) {
            this.canvas.addEventListener('touchmove', this._touchMoveHandler, {passive: true});
        }
        
        // On pointerdown/touchstart, immediately update last position (reduce delay spike)
        if (this.canvas) {
            this.canvas.addEventListener('pointerdown', this._pointerDownHandler);
        }

        if (this.canvas) {
            this.canvas.addEventListener('mousedown', this._mouseDownHandler);
        }

        // Update canvas rect on window resize
        window.addEventListener('resize', this._resizeHandler);

        // Also update canvas rect when canvas style changes
        if (this._mutationObserver) { this._mutationObserver.disconnect(); }
        this._mutationObserver = new MutationObserver(() => {
            this.updateCanvasRect();
        });
        if (this.canvas) {
            this._mutationObserver.observe(this.canvas, {
                attributes: true,
                attributeFilter: ['style']
            });
        }

        // --- [START] Track mouse position globally to support immediate update after OS switch ---
        document.addEventListener("mousemove", this._globalMouseMoveHandler);
        document.addEventListener("touchmove", this._globalTouchMoveHandler);
        // --- [END] global mouse tracking ---
    }

    setupGlobalMouseTracking() {
        // Remove any previous global listeners to avoid duplication
        document.removeEventListener("mousemove", this._globalMouseMoveHandler);
        document.removeEventListener("touchmove", this._globalTouchMoveHandler);

        document.addEventListener("mousemove", this._globalMouseMoveHandler);
        document.addEventListener("touchmove", this._globalTouchMoveHandler);
    }

    _playPingSound() {
        if (!this._pingSettings.sound) return;
        try {
            const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            fetch('asset_name.mp3')
                .then(response => response.arrayBuffer())
                .then(arrayBuffer => audioCtx.decodeAudioData(arrayBuffer))
                .then(audioBuffer => {
                    const source = audioCtx.createBufferSource();
                    source.buffer = audioBuffer;
                    source.connect(audioCtx.destination);
                    source.start();
                });
        } catch (e) {
            console.warn("Could not play ping sound", e);
        }
    }

    _handleIncomingPing(data) {
        if (!data || !data.message) return;
        
        // Mentions use the <@userID> format in the database
        const isMentioned = data.message.includes(`<@${this.currentUserId}>`);
        const mode = this._pingSettings.mode;
        
        // "Never ping me" overrides everything
        if (mode === 'none') return;
        
        const isMinimized = this.chatContainer.classList.contains('minimized');
        const isChatOpen = !isMinimized;
        
        // Missed message indicators (White border / Red mention dot)
        if (isMinimized) {
            this.chatContainer.classList.add('has-unread');
            if (isMentioned) {
                this._mentionCount++;
                this.chatContainer.classList.add('has-mention');
                this.chatContainer.setAttribute('data-mentions', this._mentionCount);
            }
        }

        // Logic:
        // 1. If mode is 'all', we ping on every message.
        // 2. If mode is 'mention', we only ping on mention.
        // 3. User requested mentions trigger ping logic regardless of "ping on mention" setting,
        //    as long as mode isn't "none".
        const shouldNotify = (mode === 'all' || isMentioned);
        
        if (!shouldNotify) return;
        if (isChatOpen && !this._pingSettings.pingIfOpen) return;

        // Bounce/Glow alert
        if (this._pingSettings.bounce && isMinimized) {
            this.chatContainer.classList.remove('ping-bounce');
            void this.chatContainer.offsetWidth; // Trigger reflow
            this.chatContainer.classList.add('ping-bounce');
            setTimeout(() => this.chatContainer.classList.remove('ping-bounce'), 1000);
        }

        // Sound
        this._playPingSound();
    }

    setupChatSystem() {
        // Get chat elements
        this.chatContainer = document.getElementById('chatContainer');
        this.chatMessages = document.getElementById('chatMessages');
        this.chatInput = document.getElementById('chatTextInput');
        this.chatSendButton = document.getElementById('chatSendButton');
        this.chatImageButton = document.getElementById('chatImageButton');
        this.chatImageInput = document.getElementById('chatImageInput');

        if (!this.chatContainer || !this.chatInput || !this.chatSendButton || !this.chatImageButton || !this.chatImageInput) {
            console.error('Chat elements not found');
            return;
        }

        const chatMinBtn = document.getElementById('chatMinimizeBtn');
        if (chatMinBtn) {
            chatMinBtn.addEventListener('click', () => {
                // Use a small timeout to check the state after index.html toggles the class
                setTimeout(() => {
                    if (!this.chatContainer.classList.contains('minimized')) {
                        this._mentionCount = 0;
                        this.chatContainer.classList.remove('has-unread', 'has-mention');
                        this.chatContainer.removeAttribute('data-mentions');
                    }
                }, 0);
            });
        }

        if (window.apiSegment === '/test') {
            const chatTitle = this.chatContainer.querySelector('#chatHeader span');
            if (chatTitle) {
                chatTitle.textContent = 'Chat (TEST MODE)';
            }
        }

        // Remove chat input maxlength for selected privileged users
        window.websim.getCurrentUser().then(user => {
            if (['VMsHARE','epic_guy','endoxidev'].includes(user?.username)) {
                if (this.chatInput.hasAttribute('maxlength')) {
                    this.chatInput.removeAttribute('maxlength');
                    this.chatInput.maxLength = 1000000000;
                    console.log('Chat limit removed for privileged user');
                }
            }
        }).catch(() => { /* ignore errors */ });

        // Send button click handler
        this.chatSendButton.addEventListener('click', () => {
            this.sendChatMessage();
        });

        // Enter key handler
        this.chatInput.addEventListener('keydown', (event) => {
            if (event.key === 'Enter' && !event.shiftKey) {
                // If mention list is open and has selection, handle that instead of sending
                if (!document.getElementById('chatMentionList').classList.contains('hidden')) {
                    const selected = document.querySelector('.mention-item.selected');
                    if (selected) {
                        event.preventDefault();
                        selected.click();
                        return;
                    }
                }
                event.preventDefault();
                this.sendChatMessage();
            }
            if (event.key === 'ArrowUp' || event.key === 'ArrowDown') {
                const list = document.getElementById('chatMentionList');
                if (!list.classList.contains('hidden')) {
                    event.preventDefault();
                    const items = Array.from(list.querySelectorAll('.mention-item'));
                    let idx = items.findIndex(i => i.classList.contains('selected'));
                    items.forEach(i => i.classList.remove('selected'));
                    if (event.key === 'ArrowUp') idx = (idx <= 0) ? items.length - 1 : idx - 1;
                    else idx = (idx >= items.length - 1) ? 0 : idx + 1;
                    items[idx].classList.add('selected');
                    items[idx].scrollIntoView({ block: 'nearest' });
                }
            }
        });

        // Paste handler to strip formatting but keep our mention structure
        this.chatInput.addEventListener('paste', (e) => {
            e.preventDefault();
            const text = e.clipboardData.getData('text/plain');
            document.execCommand('insertText', false, text);
        });

        // Mention Autocomplete
        this.chatInput.addEventListener('input', (e) => {
            // Length check handled in sendChatMessage to avoid destroying DOM/caret
            this.updateMentionAutocomplete();
        });

        // Chat Settings Button
        const settingsBtn = document.getElementById('chatSettingsBtn');
        const settingsPanel = document.getElementById('chatSettingsPanel');
        const settingsClose = document.getElementById('chatSettingsClose');
        
        if (settingsBtn && settingsPanel) {
            settingsBtn.onclick = (e) => {
                e.stopPropagation();
                settingsPanel.classList.toggle('hidden');
                this.loadChatSettingsUI();
            };
            settingsClose.onclick = () => settingsPanel.classList.add('hidden');
            
            // Wire up setting changes
            settingsPanel.addEventListener('change', (e) => {
                if (e.target.name === 'ping-mode') {
                    this._pingSettings.mode = e.target.value;
                    localStorage.setItem('chat_ping_mode', e.target.value);
                } else if (e.target.id === 'chat-ping-sound') {
                    this._pingSettings.sound = e.target.checked;
                    localStorage.setItem('chat_ping_sound', e.target.checked);
                } else if (e.target.id === 'chat-ping-bounce') {
                    this._pingSettings.bounce = e.target.checked;
                    localStorage.setItem('chat_ping_bounce', e.target.checked);
                } else if (e.target.id === 'chat-ping-open') {
                    this._pingSettings.pingIfOpen = e.target.checked;
                    localStorage.setItem('chat_ping_open', e.target.checked);
                }
            });
        }

        this.chatImageButton.addEventListener('click', () => {
            this.chatImageInput.click();
        });

        this.chatImageInput.addEventListener('change', async (event) => {
            const file = event.target.files[0];
            if (!file) return;

            // Reset file input value to allow selecting the same file again
            this.chatImageInput.value = '';

            if (!file.type.startsWith('image/')) {
                if (typeof window.showNotification === 'function') {
                    window.showNotification('Please select an image file.', 'error');
                }
                return;
            }

            // NEW: Check limits before upload (sender)
            const messageToCheck = this._getRawChatMessage().trim();
            if (messageToCheck.length > 500) {
                if (typeof window.showNotification === 'function') {
                    window.showNotification('Message text with image is too long (max 500 chars).', 'error');
                }
                return;
            }
            if (this.osCode && this.osCode.length > 100) {
                if (typeof window.showNotification === 'function') {
                    window.showNotification('OS Code too long.', 'error');
                }
                return;
            }

            const now = Date.now();
            let ratelimit = 3000; // Default ratelimit
            const tagInfo = this.userTags[this.currentUserId];
            if (tagInfo && tagInfo.tags) {
                const tags = Object.values(tagInfo.tags);
                const tagWithRatelimit = tags.find(tag => typeof tag.ratelimit === 'number');
                if (tagWithRatelimit) {
                    ratelimit = tagWithRatelimit.ratelimit;
                }
            }
            if (now - this._lastSentChatTimestamp < ratelimit) {
                if (typeof window.showNotification === 'function') {
                    window.showNotification('You are sending too fast. Please wait.', 'error');
                }
                return;
            }

            // Disable buttons during upload
            this.chatImageButton.disabled = true;
            this.chatSendButton.disabled = true;
            this.chatImageButton.textContent = '...'; // Uploading indicator

            try {
                await this._checkImageDimensions(file);

                const imageUrl = await window.websim.upload(file);
                if (!imageUrl) {
                    throw new Error('Upload returned no URL');
                }

                this._lastSentChatTimestamp = now;
                
                // Check for text in input, and send it with the image
                const message = this._getRawChatMessage().trim();
                if (message) {
                    this.chatInput.innerHTML = ''; // Clear input if sending text with image
                }
                
                let user;
                try {
                    user = await window.websim.getCurrentUser();
                } catch (e) {
                    console.warn('Could not get current user for chat:', e);
                }

                await this.room.collection('chat_message_v4').create({
                    message: message || '', // Send text if available
                    imageUrl: imageUrl,
                    osCode: this.osCode,
                    testMode: !!window.testModeEnabled,
                    user_id: user?.id,
                });

            } catch (error) {
                console.error('Error uploading image:', error);
                if (typeof window.showNotification === 'function') {
                    window.showNotification(error.message || 'Image upload failed.', 'error');
                }
            } finally {
                // Re-enable buttons
                this.chatImageButton.disabled = false;
                this.chatSendButton.disabled = false;
                this.chatImageButton.textContent = '🖼️'; // Reset icon
            }
        });

        // Auto-focus chat input when typing (if canvas doesn't need focus)
        document.addEventListener('keydown', (event) => {
            // Only focus chat if not typing in another input and not pressing special keys
            if (event.target === document.body &&
                event.key.length === 1 &&
                !event.ctrlKey &&
                !event.metaKey &&
                !event.altKey) {
                this.chatInput.focus();
            }
        });

        this.chatMessages.addEventListener('scroll', () => {
            if (this.chatMessages.scrollTop === 0 && !this._isFetchingMoreMessages) {
                if (this._chatMessagesCount < this._allChatRecords.length) {
                    this._isFetchingMoreMessages = true;
                    const oldScrollHeight = this.chatMessages.scrollHeight;
                    
                    this._chatMessagesCount += 25;
                    this.renderChat();
                    
                    // Restore scroll position after render
                    const newScrollHeight = this.chatMessages.scrollHeight;
                    this.chatMessages.scrollTop = newScrollHeight - oldScrollHeight;

                    setTimeout(() => { this._isFetchingMoreMessages = false; }, 200);
                }
            }
        });

        console.log('Chat system initialized');
    }

    setupImageViewer() {
        const overlay = document.getElementById('image-viewer-overlay');
        const content = document.getElementById('image-viewer-content');
        const img = document.getElementById('image-viewer-img');
        const closeBtn = document.getElementById('image-viewer-close');

        if (!overlay || !img || !closeBtn || !content) {
            console.error('Image viewer elements not found');
            return;
        }

        let scale = 1;
        let panning = false;
        let pointX = 0;
        let pointY = 0;
        let start = { x: 0, y: 0 };

        const setTransform = () => {
            img.style.transform = `translate(${pointX}px, ${pointY}px) scale(${scale})`;
        };

        const closeViewer = () => {
            overlay.style.display = 'none';
            // Reset state
            scale = 1;
            pointX = 0;
            pointY = 0;
            setTransform();
        };

        closeBtn.addEventListener('click', closeViewer);
        overlay.addEventListener('click', (e) => {
            if (e.target === overlay) {
                closeViewer();
            }
        });
        
        content.addEventListener('mousedown', (e) => {
            e.preventDefault();
            start = { x: e.clientX - pointX, y: e.clientY - pointY };
            panning = true;
            img.classList.add('dragging');
        });

        content.addEventListener('mouseup', () => {
            panning = false;
            img.classList.remove('dragging');
        });

        content.addEventListener('mousemove', (e) => {
            if (!panning) return;
            pointX = e.clientX - start.x;
            pointY = e.clientY - start.y;
            setTransform();
        });

        content.addEventListener('wheel', (e) => {
            e.preventDefault();
            const xs = (e.clientX - pointX) / scale;
            const ys = (e.clientY - pointY) / scale;
            const delta = -e.deltaY;

            if (delta > 0) {
                scale *= 1.2;
            } else {
                scale /= 1.2;
            }
            scale = Math.max(0.2, Math.min(scale, 10)); // Clamp scale

            pointX = e.clientX - xs * scale;
            pointY = e.clientY - ys * scale;

            setTransform();
        });

        // Make it globally available for displayChatMessage
        window.openImageViewer = (src) => {
            img.src = src;
            overlay.style.display = 'flex';
        };
    }



    // Announcement handling (moved from index.html)
    onAnnouncement(msg) {
        if (!msg || msg.type !== "announcement") return;

        const senderClientId = msg.clientId;
        if (!this.room || !this.room.presence) return;

        const senderPresence = this.room.presence[senderClientId];
        if (!senderPresence || !senderPresence.userId) {
            return;
        }
        const senderUserId = senderPresence.userId;

        const canSendGlobal = this.canSendGlobalAnnouncement(senderUserId);
        const canSendRoom = this.canSendRoomAnnouncement(senderUserId);

        if (!canSendGlobal && !canSendRoom) {
            // User has no announcement permissions, ignore.
            return;
        }

        if (!canSendGlobal && canSendRoom) {
            // This is a room-only announcement. Check if we are in the same room.
            const msgOs = String(msg.osCode || '').replace(/^\//, '');
            if (msgOs !== this.osCode) {
                return;
            }
        }

        // === MESSAGE DEDUPE for announcements ===
        const annKey = this._getMessageKey(msg);
        if (this._displayedMessageSet.has(annKey)) {
            return;
        }
        this._displayedMessageSet.add(annKey);
        this._cleanupMessageSet();
        // === END DEDUPE ===

        if (msg.timestamp && Date.now() - msg.timestamp > 2419200000) return; // 4 weeks old
        const annData = {
            content: msg.content || '',
            author: this.room.peers[msg.clientId]?.username || msg.username,
            authorId: msg.clientId || '',
            avatarUrl: this.room.peers[msg.clientId]?.avatarUrl || `https://images.websim.com/avatar/${msg.username}`,
            timestamp: msg.timestamp || Date.now()
        };
        this.addAnnouncementToDOM(annData);
    }

    // New private helper for formatting time
    _fmtTime(ts) {
        const now = Date.now(), diff = Math.round((now - ts) / 1000);
        if (diff < 60) return `${diff}s ago`;
    }

    // New private helper for dismissed announcements
    _getDismissedSet() {
        try {
            return JSON.parse(localStorage.getItem('announcements_dismissed') || '[]');
        } catch (e) {
            return [];
        }
    }

    // New private helper for saving dismissed announcements
    _saveDismissed(ann) {
        let set = this._getDismissedSet();
        if (!set.includes(ann.timestamp)) {
            set.push(ann.timestamp);
            if (set.length > 100) {
                set = set.slice(-50);
            }
            localStorage.setItem('announcements_dismissed', JSON.stringify(set));
        }
    }

    // New private helper for checking if an announcement is dismissed
    _isDismissed(ann) {
        return this._getDismissedSet().includes(ann.timestamp);
    }

    addAnnouncementToDOM(annData) {
        // Safe copy & string conversion
        const ann = { ...annData };
        try {
            const safeString = (val) => {
                if (val === null || val === undefined) return '';
                if (typeof val === 'object') {
                    try { return JSON.stringify(val); } catch(e) { return '[Object]'; }
                }
                return String(val);
            };
            ann.content = safeString(ann.content);
            ann.author = safeString(ann.author);
            ann.avatarUrl = safeString(ann.avatarUrl);
            ann.authorId = safeString(ann.authorId);
        } catch(e) {
            console.warn("Skipping malformed announcement", e);
            return;
        }

        if (this._isDismissed(ann)) return;

        const bar = document.getElementById('announcementBar');
        if (!bar) {
            console.error("announcementBar not found");
            return;
        }

        const div = document.createElement('div');
        div.className = 'announcement';
        div.innerHTML = `
            <img class="avatar" src="${ann.avatarUrl || '/favicon.ico'}" alt="avatar"/>
            <div style="flex:1;display:flex;flex-direction:column;">
            <div class="author">${ann.author || '---'}<span class="ann-meta" title="${new Date(ann.timestamp).toLocaleString()}">${this._fmtTime(ann.timestamp)}</span></div>
            <div class="content">${ann.content.replace(/</g, "&lt;").replace(/\n/g, "<br>")}</div>
            </div>
            <button class="ann-close-btn" title="Dismiss announcement">&times;</button>
        `;

        div.querySelector('.ann-close-btn').addEventListener('click', ev => {
            ev.preventDefault();
            ev.stopPropagation();
            div.classList.add('ann-dismissed');
            setTimeout(() => {
                div.remove();
            }, 1600);
            this._saveDismissed(ann);
        });

        const autoHideTimeout = setTimeout(() => {
            if (!div.matches(':hover') && !div.classList.contains('ann-dismissed')) {
                div.classList.add('ann-hidden');
            }
        }, 15000);

        div.addEventListener('mouseenter', () => {
            clearTimeout(autoHideTimeout);
            div.classList.remove('ann-hidden');
        });

        bar.appendChild(div);

        const maxAnns = 5;
        while (bar.children.length > maxAnns) {
            bar.firstChild.remove();
        }
    }
    // End of Announcement handling

    // === UNIFIED PRESENCE UPDATE SYSTEM ===
    /**
     * Updates presence by merging any provided keys into the previous presence object.
     * If no argument is provided, re-sends current presence.
     * Example: this.updatePresenceWithMerge({ osCode: "vista" })
     */
    updatePresenceWithMerge(obj = {}) {
        if (!this.room) return;
        const cid = this.room.clientId;
        // Prepare previousPresence: everything the server currently has for this client
        // Sometimes, especially very early, presence object may not yet exist.
        const previousPresence = (this.room.presence && this.room.presence[cid]) ? { ...this.room.presence[cid] } : {};
        // Merge our update keys
        const newPresence = { ...previousPresence, ...obj };
        // Ensure osCode at least is current from this.osCode
        if (!('osCode' in newPresence) || typeof newPresence.osCode === "undefined") {
            newPresence.osCode = this.osCode;
        }
        // Ensure testMode status is present
        if (!('testMode' in newPresence)) {
            newPresence.testMode = !!window.testModeEnabled;
        }
        this.room.updatePresence(newPresence);
    }

    setReplyTarget(data) {
        const inputArea = document.getElementById('chatInput');
        let bar = document.getElementById('chat-reply-preview');
        if (!bar) {
            bar = document.createElement('div');
            bar.id = 'chat-reply-preview';
            bar.style.cssText = "background:rgba(0,0,0,0.6); padding:6px 10px; font-size:11px; border-top:1px solid rgba(79,211,255,0.2); border-bottom:1px solid rgba(0,0,0,0.2); display:flex; justify-content:space-between; align-items:center; width:100%; position:relative; z-index:10;";
            inputArea.parentNode.insertBefore(bar, inputArea);
        }
        
        const snippet = data.message ? data.message.substring(0, 50) + (data.message.length > 50 ? '...' : '') : '[Image]';
        this.replyTarget = {
            id: data.id,
            username: data.username,
            snippet: snippet
        };

        bar.innerHTML = `<span>Replying to <strong>@${this.sanitize(data.username)}</strong>: ${this.sanitize(snippet)}</span><button style="background:none; border:none; color:#ff6b6b; cursor:pointer;">&times;</button>`;
        bar.querySelector('button').onclick = () => {
            this.replyTarget = null;
            bar.remove();
        };

        // Add the mention automatically
        const selection = window.getSelection();
        this.chatInput.focus();
        const mentionSpan = document.createElement('span');
        mentionSpan.className = 'chat-mention';
        mentionSpan.dataset.id = data.user_id || this.room.presence[data.clientId]?.userId;
        mentionSpan.textContent = `@${data.username}`;
        mentionSpan.contentEditable = "false";
        this.chatInput.appendChild(mentionSpan);
        this.chatInput.appendChild(document.createTextNode('\u00A0'));
        this._placeCaretAtEnd(this.chatInput);
    }

    async sendChatMessage() {
        if (!this.chatInput) return;
        
        if (!this.room || !this.room.initialized) {
            if (window.showNotification) window.showNotification('Socket connecting... please wait.', 'info');
            return;
        }

        const now = Date.now();
        
        let ratelimit = 3000;
        const tagInfo = this.userTags[this.currentUserId];
        if (tagInfo && tagInfo.tags) {
            const tags = Object.values(tagInfo.tags);
            const tagWithRatelimit = tags.find(tag => typeof tag.ratelimit === 'number');
            if (tagWithRatelimit) ratelimit = tagWithRatelimit.ratelimit;
        }
        
        if (now - this._lastSentChatTimestamp < ratelimit) {
            if (window.showNotification) window.showNotification('Sending too fast.', 'error');
            return;
        }

        let message = this._getRawChatMessage().trim();
        if (!message) return;

        if (message.length > 500) {
            if (window.showNotification) window.showNotification('Message too long.', 'error');
            return;
        }

        const lowerCaseMessage = message.toLowerCase();

        if (lowerCaseMessage === '!help') {
            this.chatInput.innerHTML = '';
            this.showHelpPopup();
            return;
        }
        
        if (lowerCaseMessage.startsWith('!np ') && this.isModerator(this.currentUserId)) {
            const npMessage = message.substring(4);
            this.room.send({
                type: 'non_persistent_message',
                userId: this.currentUserId,
                username: this.currentUsername,
                message: npMessage,
                osCode: this.osCode,
                timestamp: Date.now()
            });
            this.chatInput.innerHTML = '';
            this._lastSentChatTimestamp = now;
            return;
        }
        
        const commands = {
            '!adminlock': (arg) => `On ${arg || 'this VM'}, someone made an admin account, set a password to it, and made the non-password account a standard one.`,
            '!alkon': (arg) => `Only alkon/sleepy can reset / restore ${arg || 'that VM'}, so please ask them.`,
            '!blank': (arg) => `On ${arg || 'this VM'}, someone removed explorer or something and now the screen is blank except for the mouse.`,
            '!userlock': (arg) => `On ${arg || 'this VM'}, it's like an admin lock, but it's just locking the main account behind a password and then going to the lock screen.`,
            '!brokenvm': (arg) => `${arg ? 'The VM "' + this.sanitize(arg) + '" is' : 'The VM is'} broken. Please report it on Discord.`
        };

        const parts = lowerCaseMessage.split(' ');
        const command = parts[0];

        if (commands[command]) {
            const args = message.substring(command.length).trim();
            message = commands[command](args);
        }

        const messageData = {
            message: message,
            osCode: this.osCode,
            testMode: !!window.testModeEnabled,
            user_id: this.currentUserId,
            parent_message_id: this.replyTarget?.id || null,
            reply_context: this.replyTarget ? JSON.stringify(this.replyTarget) : null,
            username: this.currentUsername
        };

        // UI cleanup
        const oldContent = this.chatInput.innerHTML;
        this.chatInput.innerHTML = '';
        const oldReplyTarget = this.replyTarget;
        this.replyTarget = null;
        const preview = document.getElementById('chat-reply-preview');
        if (preview) preview.remove();

        // Create DB record
        try {
            this._lastSentChatTimestamp = now;
            await this.room.collection('chat_message_v4').create(messageData);
            console.log('Chat message persisted to DB');
        } catch (err) {
            console.error('Failed to create chat record:', err);
            if (window.showNotification) window.showNotification('Failed to send message. Put it back in input.', 'error');
            this.chatInput.innerHTML = oldContent;
            this.replyTarget = oldReplyTarget;
            // Re-render preview if it was there
            if (this.replyTarget) this.setReplyTarget({ id: this.replyTarget.id, username: this.replyTarget.username, message: this.replyTarget.snippet });
        }
    }

    handleChatMessages(messages) {
        // messages are newest to oldest from the database
        this._allChatRecords = messages;
        this.renderChat();
    }

    loadChatSettingsUI() {
        const panel = document.getElementById('chatSettingsPanel');
        if (!panel) return;
        const radios = panel.querySelectorAll('input[name="ping-mode"]');
        radios.forEach(r => r.checked = (r.value === this._pingSettings.mode));
        document.getElementById('chat-ping-sound').checked = this._pingSettings.sound;
        document.getElementById('chat-ping-bounce').checked = this._pingSettings.bounce;
        document.getElementById('chat-ping-open').checked = this._pingSettings.pingIfOpen;
    }

    _getRawChatMessage() {
        if (!this.chatInput) return "";
        let rawText = "";
        
        // Traverse nodes to build the raw message with <@id>
        const walk = (node) => {
            if (node.nodeType === Node.TEXT_NODE) {
                rawText += node.nodeValue;
            } else if (node.nodeType === Node.ELEMENT_NODE) {
                if (node.classList.contains('chat-mention')) {
                    rawText += `<@${node.dataset.id}>`;
                } else if (node.tagName === 'BR') {
                    rawText += '\n';
                } else {
                    for (const child of node.childNodes) {
                        walk(child);
                    }
                }
            }
        };
        
        for (const child of this.chatInput.childNodes) {
            walk(child);
        }
        
        return rawText;
    }

    _placeCaretAtEnd(el) {
        el.focus();
        if (typeof window.getSelection != "undefined" && typeof document.createRange != "undefined") {
            const range = document.createRange();
            range.selectNodeContents(el);
            range.collapse(false);
            const sel = window.getSelection();
            sel.removeAllRanges();
            sel.addRange(range);
        }
    }

    updateMentionAutocomplete() {
        const input = this.chatInput;
        const list = document.getElementById('chatMentionList');
        
        // Use Selection API for contenteditable
        const selection = window.getSelection();
        if (!selection.rangeCount) return;
        const range = selection.getRangeAt(0);
        const cursorContainer = range.startContainer;
        
        // Only trigger if typing in a text node
        if (cursorContainer.nodeType !== Node.TEXT_NODE) {
            list.classList.add('hidden');
            return;
        }

        const val = cursorContainer.nodeValue;
        const offset = range.startOffset;
        
        const beforeCursor = val.substring(0, offset);
        const lastAt = beforeCursor.lastIndexOf('@');
        
        if (lastAt !== -1) {
            const query = beforeCursor.substring(lastAt + 1).toLowerCase();
            // Ensure no space between @ and cursor
            if (!query.includes(' ')) {
                const onlineUsers = [];
                const seenIds = new Set();
                
                // Get all users from current presence
                Object.keys(this.room.presence || {}).forEach(cid => {
                    const peer = this.room.peers[cid];
                    if (peer && peer.username) {
                        const uid = this.room.presence[cid].userId;
                        if (!seenIds.has(uid)) {
                            const profile = this.userProfiles[uid] || {};
                            onlineUsers.push({
                                userId: uid,
                                username: peer.username,
                                nickname: profile.nickname || peer.username,
                                avatar: `https://images.websim.com/avatar/${peer.username}`
                            });
                            seenIds.add(uid);
                        }
                    }
                });

                const filtered = onlineUsers.filter(u => 
                    (u.username && typeof u.username === 'string' && u.username.toLowerCase().includes(query)) || 
                    (u.nickname && typeof u.nickname === 'string' && u.nickname.toLowerCase().includes(query))
                ).slice(0, 10);

                if (filtered.length > 0) {
                    list.innerHTML = '';
                    filtered.forEach((u, idx) => {
                        const item = document.createElement('div');
                        item.className = 'mention-item' + (idx === 0 ? ' selected' : '');
                        item.innerHTML = `<img src="${u.avatar}"> <span>${this.sanitize(u.nickname)} (@${this.sanitize(u.username)})</span>`;
                        item.onclick = () => {
                            // Delete the typed @query
                            range.setStart(cursorContainer, lastAt);
                            range.setEnd(cursorContainer, offset);
                            range.deleteContents();
                            
                            // Insert the mention span
                            const mentionSpan = document.createElement('span');
                            mentionSpan.className = 'chat-mention';
                            mentionSpan.dataset.id = u.userId;
                            mentionSpan.textContent = `@${u.nickname}`;
                            mentionSpan.contentEditable = "false"; // Non-editable block
                            
                            range.insertNode(mentionSpan);
                            
                            // Insert a trailing space
                            const space = document.createTextNode('\u00A0');
                            range.setStartAfter(mentionSpan);
                            range.insertNode(space);
                            range.setStartAfter(space);
                            range.collapse(true);
                            
                            selection.removeAllRanges();
                            selection.addRange(range);
                            
                            list.classList.add('hidden');
                            input.focus();
                        };
                        list.appendChild(item);
                    });
                    list.classList.remove('hidden');
                    return;
                }
            }
        }
        list.classList.add('hidden');
    }

    renderChat() {
        if (!this.chatMessages || !this._allChatRecords) return;

        const isScrolledToBottom = (this.chatMessages.clientHeight === 0) || 
                                 (this.chatMessages.scrollHeight - this.chatMessages.clientHeight <= this.chatMessages.scrollTop + 100);

        // Records from subscribe are newest to oldest. We want oldest at top.
        const messagesToRender = [...this._allChatRecords]
            .slice(0, this._chatMessagesCount) // Take 50 newest
            .reverse(); // Now oldest to newest
        
        const validKeys = new Set();
        
        messagesToRender.forEach(record => {
            const key = record.id;
            validKeys.add(key);
            
            let el = Array.from(this.chatMessages.children).find(c => c.dataset.messageKey === key);
            
            if (el) {
                const currentData = JSON.parse(el.dataset.messageData || '{}');
                if (currentData.deleted !== record.deleted || 
                    currentData.message !== record.message || 
                    currentData.imageUrl !== record.imageUrl) {
                    const newEl = this.createMessageElement(record);
                    if (newEl) this.chatMessages.replaceChild(newEl, el);
                }
            } else {
                el = this.createMessageElement(record);
                if (el) {
                    this.chatMessages.appendChild(el);
                    
                    // Handle ping for fresh incoming messages (within last 10s)
                    const ts = new Date(record.created_at).getTime();
                    if (Date.now() - ts < 10000 && record.username !== this.currentUsername) {
                        this._handleIncomingPing(record);
                    }
                }
            }
        });

        // Cleanup: Remove old messages no longer in the newest batch
        Array.from(this.chatMessages.children).forEach(el => {
            const key = el.dataset.messageKey;
            if (key && !key.startsWith('sys_') && !validKeys.has(key)) {
                el.remove();
            }
        });

        if (isScrolledToBottom) {
            this.chatMessages.scrollTop = this.chatMessages.scrollHeight;
        }
    }

    displayChatMessage(data) {
        // This function will now only be called for system messages or non-persistent moderator messages,
        // as database messages are handled by createMessageElement.
        // It's kept for compatibility with those other features.
        const msgKey = this._getMessageKey(data);
        if (this._displayedMessageSet.has(msgKey)) return;

        const messageElement = this.createMessageElement(data);
        if (messageElement) {
            this._displayedMessageSet.add(msgKey);
            this.chatMessages.appendChild(messageElement);
            this.chatMessages.scrollTop = this.chatMessages.scrollHeight;
        }
    }

    createMessageElement(originalData) {
        // Work on a shallow copy to safely modify limits without affecting original object
        const data = { ...originalData };

        try {
            const safeString = (val) => {
                if (val === null || val === undefined) return '';
                if (typeof val === 'object') {
                    try { return JSON.stringify(val); } catch(e) { return '[Object]'; }
                }
                return String(val);
            };

            // Ensure critical string fields are actually strings to prevent runtime errors
            if ('message' in data) data.message = safeString(data.message);
            if ('osCode' in data) data.osCode = safeString(data.osCode);
            if ('username' in data) data.username = safeString(data.username);
            if ('imageUrl' in data) data.imageUrl = safeString(data.imageUrl);
            if ('user_id' in data) data.user_id = safeString(data.user_id);

            // NEW: Enforce limits on receiver
            if (data.message && data.message.length > 500) {
                data.message = "Content moderated";
            }
            if (data.osCode && data.osCode.length > 100) {
                data.osCode = "Unknown";
            }
        } catch (e) {
            console.warn("Skipping malformed message:", e);
            return null;
        }

        // This is now for rendering a single message record from the DB
        const userId = data.user_id;
        const username = data.username;

        // Define isShowingDeleted - determines if we're in a mode where deleted messages are visible
        const isShowingDeleted = data.deleted && this.isModerator(this.currentUserId);

        // NEW: Tag-based chat and image permissions
        const userTagsData = this.userTags[userId];
        let canChat = true;
        let canSendImages = true;
        let canBot = false;

        if (userTagsData && userTagsData.tags) {
            const tags = Object.values(userTagsData.tags);
            // `chat` defaults to true. If any tag sets it to false, user can't chat.
            if (tags.some(tag => tag.chat === false)) {
                canChat = false;
            }
            // `image` defaults to true. If any tag sets it to false, user can't send images.
            if (tags.some(tag => tag.image === false)) {
                canSendImages = false;
            }
            // Check for bot permission
            if (tags.some(tag => tag.canBot === true)) {
                canBot = true;
            }
        }

        if (!canChat) {
            console.log(`Message from ${username} (${userId}) blocked by chat permission tag.`);
            return null; // Don't display any message
        }
        if (data.imageUrl && !canSendImages) {
            console.log(`Image message from ${username} (${userId}) blocked by image permission tag.`);
            return null; // Don't display message with image
        }

        // BOT osCode restriction
        const tempNormalizedOs = String(data.osCode||'').replace(/^\//, '');
        if (tempNormalizedOs === "BOT" && !canBot) {
            return null;
        }

        // NEW: Check if user is blocked
        const blockedUsers = this.getBlockedUsers();
        if (blockedUsers.includes(username) && username !== this.currentUsername) {
            return this.createBlockedMessagePlaceholder(username);
        }

        // Note: Receiver-side ratelimiting is removed as it caused flickering during re-renders. 
        // Canonical timestamps from the database now handle message order and pacing.

        // Test mode chat separation
        const messageInTestMode = !!data.testMode;
        const clientInTestMode = !!window.testModeEnabled;
        if (messageInTestMode !== clientInTestMode) {
            return null; // Don't display message if modes don't match
        }

        // Common setup
        if (!this.chatMessages) return null;

        const msgKey = this._getMessageKey(data);
        // Deduplication is handled in renderChat now, but we keep this as a safeguard for direct calls
        if (this._displayedMessageSet.has(msgKey) && !data.id?.startsWith('optimistic') && !isShowingDeleted) {
             // return null;
        }

        // Normalize OS code
        const normalizedOs = String(data.osCode||'').replace(/^\//, '');
        const isBot = (normalizedOs === 'BOT');

        // Prepare badges
        let badgeHTML = this._generateBadgesHtml(userId);
        if (isBot) {
            badgeHTML = `<span style="padding:1px 4px;border-radius:3px;font-size:10px;vertical-align:middle;display:inline-block;line-height:1;margin-left:5px;background:#5865F2;color:#ffffff;font-family:inherit;box-shadow:none;">BOT</span>`;
        }

        // Get label
        const osLabel = this.sanitize(this.getOSLabel(normalizedOs));
        
        const profile = this.userProfiles[userId] || {};
        let nickname = profile.nickname || username;
        
        if (isBot) {
            nickname = `BOT (${nickname})`;
        }

        // Create message container
        const messageElement = document.createElement('div');
        messageElement.className = 'chat-message';
        if (isShowingDeleted) {
            messageElement.classList.add('showing-deleted');
        }
        messageElement.dataset.messageKey = msgKey; // Store key for pruning
        const isOwnMessage = username === this.currentUsername;
        if (isOwnMessage) {
            messageElement.classList.add('own-message');
        }
        
        // Store original message data on the element for re-rendering
        try {
            messageElement.dataset.messageData = JSON.stringify(data);
        } catch (e) {
            console.warn("Could not store message data for re-rendering", e);
        }
        
        // Avatar
        const avatar = document.createElement('img');
        avatar.className = 'chat-avatar';
        avatar.src = `https://images.websim.com/avatar/${username}`;
        avatar.alt = 'avatar';
        messageElement.appendChild(avatar);

        const contentContainer = document.createElement('div');
        contentContainer.className = 'chat-content';

        // Header line: Nickname [OS] badges
        const header = document.createElement('div');
        header.className = 'chat-header';

        // Check for reply data
        let replyHtml = '';
        if (data.parent_message_id) {
            const replyTargetData = JSON.parse(data.reply_context || '{}');
            replyHtml = `
                <div class="chat-reply-indicator" style="font-size: 10px; opacity: 0.6; margin-bottom: 2px; cursor: pointer; display: flex; align-items: center; gap: 4px;" data-target-id="${this.sanitize(data.parent_message_id)}">
                    <span style="font-size: 12px;">⮤</span> Replied to <strong>@${this.sanitize(replyTargetData.username || 'unknown')}</strong>: <span style="font-style: italic;">"${this.sanitize(replyTargetData.snippet || '...')}"</span>
                </div>
            `;
        }
        
        // Add options button for eligible users
        let optionsButtonHtml = '';
        const isMessageCreator = username === this.currentUsername;
        const isProjectCreator = this.projectCreator && this.projectCreator.username === this.currentUsername;
        
        if (isMessageCreator || isProjectCreator || !isOwnMessage || this.currentUserIsModerator) {
            optionsButtonHtml = `
                <div class="message-options">
                    <button class="options-btn" title="Message Options">⋯</button>
                    <div class="options-menu">
                        ${isProjectCreator ? '<button class="option-item" data-action="permanent" title="Permanently Delete">Perma Delete</button>' : ''}
                        ${(isProjectCreator || isMessageCreator) ? '<button class="option-item" data-action="soft" title="Hide Delete">Hide Delete</button>' : ''}
                        ${!isOwnMessage ? '<button class="option-item" data-action="reply" title="Reply to Message">Reply</button>' : ''}
                        ${!isOwnMessage ? '<button class="option-item" data-action="block" title="Block User">Block</button>' : ''}
                        ${this.currentUserIsModerator && !isOwnMessage ? `
                            <button class="option-item" data-action="mod-manage" style="color:#ff6b6b; font-weight:bold;" title="Moderator Management">Mod Manage...</button>
                        ` : ''}
                    </div>
                </div>
            `;
        }
        
        header.innerHTML = `
            <div style="display: flex; flex-direction: column; width: 100%;">
                ${replyHtml}
                <div style="display: flex; align-items: center; justify-content: space-between; width: 100%;">
                    <div style="display: flex; flex-direction: column; gap: 2px;">
                    <div style="display: flex; align-items: center; gap: 5px;">
                        <span class="chat-nickname" title="@${this.sanitize(username)}">${this.sanitize(nickname)}</span>${badgeHTML}
                        <span class="chat-time" style="font-size: 9px; opacity: 0.5; margin-left: 4px;">${new Date(data.created_at).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' })}</span>
                    </div>
                    ${!isBot ? `<span class="os-label" style="font-size: 10px; opacity: 0.7;">[${osLabel}]</span>` : ''}
                </div>
                ${optionsButtonHtml}
            </div>
        `;
        contentContainer.appendChild(header);

        // Add options button event listeners
        const optionsBtn = header.querySelector('.options-btn');
        const optionsMenu = header.querySelector('.options-menu');
        if (optionsBtn && optionsMenu) {
            optionsBtn.addEventListener('click', (e) => {
                e.stopPropagation();
                // Close other open menus
                document.querySelectorAll('.options-menu.show').forEach(menu => {
                    if (menu !== optionsMenu) menu.classList.remove('show');
                });
                optionsMenu.classList.toggle('show');
            });

            // Close menu when clicking outside
            document.addEventListener('click', (e) => {
                if (!header.contains(e.target)) {
                    optionsMenu.classList.remove('show');
                }
            });

            // Handle option clicks
            optionsMenu.addEventListener('click', async (e) => {
                e.stopPropagation();
                const action = e.target.dataset.action;
                if (action) {
                    optionsMenu.classList.remove('show');
                    if (action === 'block') {
                        await this.handleUserBlock(username);
                    } else if (action === 'reply') {
                        this.setReplyTarget(data);
                    } else if (action === 'mod-manage') {
                        const uData = (window.modResponseData?.rework?.users || {})[userId] || { lastKnownUsername: username };
                        this.openModHub(userId, uData);
                    } else {
                        await this.handleMessageDelete(data, action);
                    }
                }
            });
        }

        // Reply indicator click handler
        const replyInd = header.querySelector('.chat-reply-indicator');
        if (replyInd) {
            replyInd.onclick = (e) => {
                e.stopPropagation();
                const targetId = replyInd.dataset.targetId;
                const targetMsg = Array.from(this.chatMessages.children).find(c => c.dataset.messageKey === targetId);
                if (targetMsg) {
                    targetMsg.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    targetMsg.style.outline = '2px solid #ff6b6b';
                    setTimeout(() => { targetMsg.style.outline = 'none'; }, 2000);
                } else {
                    if(window.showNotification) window.showNotification("Reply target not in local history", "info");
                }
            };
        }

        // Body line: the message
        const body = document.createElement('div');
        body.className = 'chat-body';

        // Check if message mentions current user (ID or group tags)
        const isMentioningMe = data.message?.includes(`<@${this.currentUserId}>`) || 
                              ((data.message?.includes('@everyone') || data.message?.includes('@here')) && this.isModerator(userId));
        
        if (isMentioningMe) {
            messageElement.style.background = 'rgba(255, 140, 0, 0.15)';
        }
        
        // NEW: Apply CSS from tags
        let chatCss = '';
        if (userTagsData && userTagsData.tags) {
            const tags = Object.values(userTagsData.tags);
            tags.forEach(tag => {
                if (isOwnMessage && tag.ownChatCss) {
                    chatCss += tag.ownChatCss + ';';
                } else if (!isOwnMessage && tag.chatCss) {
                    chatCss += tag.chatCss + ';';
                }
            });
        }
        if (chatCss) {
            body.style.cssText = chatCss;
        }

        // Handle image URL if present
        if (data.imageUrl) {
            const imageContainer = document.createElement('div');
            imageContainer.className = 'image-container';

            const link = document.createElement('a');
            link.href = data.imageUrl;
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.title = 'Open image in new tab';

            const img = document.createElement('img');
            img.src = data.imageUrl;
            img.alt = 'User uploaded image';
            img.onload = () => {
                // NEW: Check dimensions on load before displaying fully
                if (img.naturalWidth > 2000 || img.naturalHeight > 2000) {
                    // Replace image with an error message/placeholder
                    imageContainer.innerHTML = `<div class="image-too-large">Image is too large (${img.naturalWidth}x${img.naturalHeight}). Max is 2000x2000.</div>`;
                    // Scroll to bottom after error placeholder is rendered
                    this.chatMessages.scrollTop = this.chatMessages.scrollHeight;
                    return;
                }
                
                // Scroll to bottom after image loads to keep view correct
                this.chatMessages.scrollTop = this.chatMessages.scrollHeight;
            };
            img.onerror = () => {
                img.classList.add('failed-to-load');
                this.chatMessages.scrollTop = this.chatMessages.scrollHeight;
            };

            // Add click listener to open viewer
            img.addEventListener('click', (e) => {
                e.preventDefault();
                if (typeof window.openImageViewer === 'function') {
                    window.openImageViewer(data.imageUrl);
                }
            });

            link.appendChild(img);
            imageContainer.appendChild(link);

            const showImageBtn = document.createElement('button');
            showImageBtn.className = 'show-image-btn';
            showImageBtn.textContent = 'Show Image';
            showImageBtn.onclick = (e) => {
                e.preventDefault();
                if (typeof window.openImageViewer === 'function') {
                    window.openImageViewer(data.imageUrl);
                }
            };
            imageContainer.appendChild(showImageBtn);

            body.appendChild(imageContainer);
        }

        // Update name resolution cache from incoming messages
        if (userId && username) {
            this._userNameCache[userId] = username;
        }

        // Handle text message if present. An image can be sent with or without a message.
        if (data.message && data.message.trim() !== '') {
            const textPart = document.createElement('div');
            textPart.className = 'chat-text-content';
            if (data.imageUrl) {
                textPart.style.marginTop = '5px';
            }
            
            // Use unified renderer for mentions and text/XSS
            this.renderMessageText(data.message, textPart, userId);
            body.appendChild(textPart);
        }

        // Track last rendered timestamp per user to aid in local scrolling context (but not for rate limiting)
        const messageTimestamp = new Date(data.created_at).getTime();
        if (username && !isShowingDeleted) {
            this._userLastMessageTimestamp[username] = Math.max(this._userLastMessageTimestamp[username] || 0, messageTimestamp);
        }
        
        contentContainer.appendChild(body);
        messageElement.appendChild(contentContainer);

        // Add click listeners for profile popup
        const nicknameEl = header.querySelector('.chat-nickname');
        const clickableElements = [avatar, nicknameEl];
        clickableElements.forEach(el => {
            if (el) {
                el.addEventListener('click', () => {
                    this.showProfilePopup(userId, username);
                });
            }
        });

        return messageElement;
    }

    // NEW: Create blocked message placeholder
    createBlockedMessagePlaceholder(username) {
        const messageElement = document.createElement('div');
        messageElement.className = 'chat-message blocked-message';
        messageElement.innerHTML = `
            <div class="chat-content">
                <div class="chat-body blocked-placeholder">
                    [1 message from blocked user ${this.sanitize(username)}]
                    <button class="unblock-btn" data-username="${this.sanitize(username)}" style="margin-left: 8px; font-size: 11px; padding: 2px 6px;">Unblock</button>
                </div>
            </div>
        `;
        
        // Add unblock functionality
        const unblockBtn = messageElement.querySelector('.unblock-btn');
        if (unblockBtn) {
            unblockBtn.addEventListener('click', () => {
                this.unblockUser(username);
            });
        }
        
        return messageElement;
    }

    // NEW: Block user functionality
    async handleUserBlock(username) {
        const blockedUsers = this.getBlockedUsers();
        if (!blockedUsers.includes(username)) {
            blockedUsers.push(username);
            this.saveBlockedUsers(blockedUsers);
            
            // Refresh chat to hide blocked user's messages
            this.rerenderChatMessages();
            
            if (typeof window.showNotification === 'function') {
                window.showNotification(`Blocked ${username}`, 'success');
            }
        }
    }

    // NEW: Unblock user functionality
    unblockUser(username) {
        const blockedUsers = this.getBlockedUsers();
        const index = blockedUsers.indexOf(username);
        if (index > -1) {
            blockedUsers.splice(index, 1);
            this.saveBlockedUsers(blockedUsers);
            
            // Refresh chat to show unblocked user's messages
            this.rerenderChatMessages();
            
            if (typeof window.showNotification === 'function') {
                window.showNotification(`Unblocked ${username}`, 'success');
            }
        }
    }

    // NEW: Get blocked users from localStorage
    getBlockedUsers() {
        try {
            return JSON.parse(localStorage.getItem('blocked_users') || '[]');
        } catch (e) {
            return [];
        }
    }

    // NEW: Save blocked users to localStorage
    saveBlockedUsers(blockedUsers) {
        try {
            localStorage.setItem('blocked_users', JSON.stringify(blockedUsers));
        } catch (e) {
            console.warn('Failed to save blocked users:', e);
        }
    }

    async handleMessageDelete(messageData, action) {
        try {
            switch (action) {
                case 'soft':
                    // Soft delete: set deleted = true
                    await this.room.collection('chat_message_v4').update(messageData.id, {
                        deleted: true
                    });
                    break;
                case 'hide':
                    // Hide delete: same as soft delete for project creator
                    await this.room.collection('chat_message_v4').update(messageData.id, {
                        deleted: true
                    });
                    break;
                case 'permanent':
                    // Permanent delete: remove from database completely
                    await this.room.collection('chat_message_v4').delete(messageData.id);
                    break;
                default:
                    console.warn('Unknown delete action:', action);
                    return;
            }
            
            if (typeof window.showNotification === 'function') {
                const actionName = action === 'permanent' ? 'permanently deleted' : 'deleted';
                window.showNotification(`Message ${actionName}`, 'success');
            }
        } catch (error) {
            console.error('Failed to delete message:', error);
            if (typeof window.showNotification === 'function') {
                window.showNotification('Failed to delete message', 'error');
            }
        }
    }

    // Modified method to show profile popup with editing capability
    showProfilePopup(userId, username) {
        if (!userId || !username) return;

        const profile = this.userProfiles[userId] || {};
        const tags = this.userTags[userId]?.tags || {};

        const nickname = profile.nickname || username;
        const bio = profile.bio || 'No bio yet.';
        const roles = this._generateBadgesHtml(userId);

        // Populate the modal elements
        document.getElementById('profile-popup-avatar').src = `https://images.websim.com/avatar/${username}`;
        document.getElementById('profile-popup-nickname').textContent = nickname;
        document.getElementById('profile-popup-username').textContent = `[@${username}]`;
        document.getElementById('profile-popup-bio').textContent = bio;
        document.getElementById('profile-popup-roles').innerHTML = roles || '<i>No roles.</i>';

        // Determine if this profile can be edited
        const isOwnProfile = userId === this.currentUserId;
        const isProjectCreator = this.projectCreator && this.projectCreator.username === this.currentUsername;
        const canEdit = isOwnProfile || isProjectCreator;

        const editControls = document.getElementById('profile-edit-controls');
        const nicknameInput = document.getElementById('profile-edit-nickname');
        const bioInput = document.getElementById('profile-edit-bio');
        const tagTextInput = document.getElementById('profile-edit-tag-text');
        const tagBgInput = document.getElementById('profile-edit-tag-bg');
        const tagColorInput = document.getElementById('profile-edit-tag-color');
        
        // New inputs
        const tagPaddingInput = document.getElementById('profile-edit-tag-padding');
        const tagSizeInput = document.getElementById('profile-edit-tag-size');
        const tagShadowEnable = document.getElementById('profile-edit-tag-has-shadow');
        const tagShadowColor = document.getElementById('profile-edit-tag-shadow');
        const tagShadowMode = document.getElementById('profile-edit-tag-mode');
        const tagShadowIntensity = document.getElementById('profile-edit-tag-intensity');
        const tagFontInput = document.getElementById('profile-edit-tag-font');

        const saveBtn = document.getElementById('profile-save-edit-btn');

        if (canEdit && editControls && nicknameInput && bioInput && saveBtn) {
            // Show edit controls
            editControls.style.display = 'block';
            nicknameInput.value = profile.nickname || '';
            bioInput.value = profile.bio || '';
            if (tagTextInput) tagTextInput.value = profile.tag_text || '';
            if (tagBgInput) tagBgInput.value = profile.tag_bg || '#333333';
            if (tagColorInput) tagColorInput.value = profile.tag_color || '#ffffff';
            
            // Populate new inputs
            if (tagPaddingInput) tagPaddingInput.value = (profile.tag_padding !== undefined && profile.tag_padding !== null) ? profile.tag_padding : 1;
            if (tagSizeInput) tagSizeInput.value = (profile.tag_size !== undefined && profile.tag_size !== null) ? profile.tag_size : 10;
            if (tagShadowEnable) tagShadowEnable.checked = !!profile.tag_shadow;
            if (tagShadowColor) tagShadowColor.value = profile.tag_shadow || '#000000';
            if (tagShadowMode) tagShadowMode.value = profile.tag_shadow_mode || 'drop';
            if (tagShadowIntensity) tagShadowIntensity.value = profile.tag_shadow_intensity || 1;
            if (tagFontInput) tagFontInput.value = profile.tag_font || 0;

            // Remove any previous event listeners to avoid duplicates
            const newSaveBtn = saveBtn.cloneNode(true);
            saveBtn.parentNode.replaceChild(newSaveBtn, saveBtn);

            // Add save handler
            newSaveBtn.addEventListener('click', async () => {
                const newNickname = nicknameInput.value.trim();
                const newBio = bioInput.value.trim();
                const newTagText = tagTextInput ? tagTextInput.value.trim().substring(0, 10) : '';
                const newTagBg = tagBgInput ? tagBgInput.value : '';
                const newTagColor = tagColorInput ? tagColorInput.value : '';
                
                // Get new styling values
                const newTagPadding = tagPaddingInput ? parseInt(tagPaddingInput.value) : 1;
                const newTagSize = tagSizeInput ? parseInt(tagSizeInput.value) : 10;
                const hasShadow = tagShadowEnable ? tagShadowEnable.checked : false;
                const newTagShadow = hasShadow && tagShadowColor ? tagShadowColor.value : null;
                const newTagShadowMode = hasShadow && tagShadowMode ? tagShadowMode.value : 'drop';
                const newTagShadowIntensity = hasShadow && tagShadowIntensity ? parseInt(tagShadowIntensity.value) : 1;
                const newTagFont = tagFontInput ? parseInt(tagFontInput.value) : 0;

                // Clamp values
                const finalPadding = Math.max(0, Math.min(5, isNaN(newTagPadding) ? 1 : newTagPadding));
                const finalSize = Math.max(8, Math.min(14, isNaN(newTagSize) ? 10 : newTagSize));

                newSaveBtn.disabled = true;
                newSaveBtn.textContent = 'Saving...';

                try {
                    if (!this.room) {
                        throw new Error('Room not initialized');
                    }

                    // Check if user already has a profile record
                    const existingProfile = this.userProfiles[userId];

                    if (existingProfile && existingProfile.id) {
                        // Update existing profile
                        await this.room.collection('user_profile_v1').update(existingProfile.id, {
                            nickname: newNickname,
                            bio: newBio,
                            tag_text: newTagText,
                            tag_bg: newTagBg,
                            tag_color: newTagColor,
                            tag_padding: finalPadding,
                            tag_size: finalSize,
                            tag_shadow: newTagShadow,
                            tag_shadow_mode: newTagShadowMode,
                            tag_shadow_intensity: newTagShadowIntensity,
                            tag_font: newTagFont
                        });
                    } else {
                        // Create new profile
                        await this.room.collection('user_profile_v1').create({
                            user_id: userId,
                            username: username,
                            nickname: newNickname,
                            bio: newBio,
                            tag_text: newTagText,
                            tag_bg: newTagBg,
                            tag_color: newTagColor,
                            tag_padding: finalPadding,
                            tag_size: finalSize,
                            tag_shadow: newTagShadow,
                            tag_shadow_mode: newTagShadowMode,
                            tag_shadow_intensity: newTagShadowIntensity,
                            tag_font: newTagFont
                        });
                    }

                    if (typeof window.showNotification === 'function') {
                        window.showNotification('Profile updated!', 'success');
                    }

                    // Update display immediately
                    document.getElementById('profile-popup-nickname').textContent = newNickname || username;
                    document.getElementById('profile-popup-bio').textContent = newBio || 'No bio yet.';
                    // Roles update is trickier without re-fetching profile, but data is pushed by subscription

                    // Close popup after short delay
                    setTimeout(() => {
                        document.getElementById('profile-popup-overlay').style.display = 'none';
                    }, 500);
                } catch (error) {
                    console.error('Failed to save profile:', error);
                    if (typeof window.showNotification === 'function') {
                        window.showNotification('Failed to update profile', 'error');
                    }
                } finally {
                    newSaveBtn.disabled = false;
                    newSaveBtn.textContent = 'Save Changes';
                }
            });
        } else if (editControls) {
            // Hide edit controls if user can't edit
            editControls.style.display = 'none';
        }
        
        document.getElementById('profile-popup-overlay').style.display = 'flex';
    }

    _isChatContainerHovered() {
        return false; // Deprecated hover logic
    }

    updateCanvasRect() {
        if (this.canvas) {
            this.canvasRect = this.canvas.getBoundingClientRect();
            // Correction: if canvas size is zero, force getBoundingClientRect next nonzero frame
            if ((this.canvasRect.width === 0 || this.canvasRect.height === 0) && this.canvas.offsetWidth && this.canvas.offsetHeight) {
                setTimeout(() => this.updateCanvasRect(), 100);
            }
        }
    }

    handleMouseMove(event) {
        // Note: Instead of canvas-relative, use browser window/page position (constant positions)
        // This makes mouse position constant across any OS or screen
        if (!this.room) return;

        const now = Date.now();
        if (now - this.lastUpdate < this.updateThrottle) return;

        // Use pageX/pageY as the global mouse position
        // If event is a touch event, ensure fallback
        let x = (typeof event.pageX === "number") ? event.pageX : (typeof event.clientX === "number" ? event.clientX : 0);
        let y = (typeof event.pageY === "number") ? event.pageY : (typeof event.clientY === "number" ? event.clientY : 0);

        // Use global document width/height for normalization. Use window.innerWidth/innerHeight.
        // Always clamp percent to 0-100 for robustness.
        const windowWidth = window.innerWidth || document.documentElement.clientWidth || 1;
        const windowHeight = window.innerHeight || document.documentElement.clientHeight || 1;

        const percX = (x / windowWidth) * 100;
        const percY = (y / windowHeight) * 100;

        const tx = Math.max(0, Math.min(100, Math.round(percX * 10) / 10));
        const ty = Math.max(0, Math.min(100, Math.round(percY * 10) / 10));

        // Only update if position changed significantly
        const deltaX = Math.abs(tx - this.myLastPosition.x);
        const deltaY = Math.abs(ty - this.myLastPosition.y);

        if (deltaX > 0.1 || deltaY > 0.1 || now - this.lastUpdate > 2000) {
            this.myLastPosition = { x: tx, y: ty };

            this.updatePresenceWithMerge({
                cursorX: tx,
                cursorY: ty,
                timestamp: now
            });
            this.lastUpdate = now;
        }
    }

    startFadeChecker() {
        // Check every second for cursors that need to fade
        this.fadeCheckInterval = setInterval(() => {
            this.checkCursorFade();
        }, 1000);
    }

    checkCursorFade() {
        const now = Date.now();
        
        this.cursors.forEach((cursorInfo, clientId) => {
            if (cursorInfo.lastUpdate && (now - cursorInfo.lastUpdate) > this.fadeTimeout) {
                // Fade out cursor
                cursorInfo.element.style.opacity = '0';
            }
        });
    }

    // --- FIX: Ensure presence always reflects most recent positions ---
    updateCursors(allPresence, force = false) {
        // Optimization: Only update moderation UI state when presence actually changes, not every cursor move
        if (!this._lastModUIUpdate || Date.now() - this._lastModUIUpdate > 5000) {
            this.updateModerationUIState();
            this._lastModUIUpdate = Date.now();
        }

        // Detect structural change (joins/leaves/switches)
        let structuralChange = force || Object.keys(allPresence).length !== Object.keys(this._lastPresenceCache || {}).length;
        if (!structuralChange && this._lastPresenceCache) {
            // Check if anyone switched OS
            for (const cid in allPresence) {
                if (allPresence[cid].osCode !== this._lastPresenceCache[cid]?.osCode) {
                    structuralChange = true;
                    break;
                }
            }
        }
        
        // Reset counts and grouped players
        const newOsPlayerCounts = {};
        const newOsPlayers = {};

        const clientInTestMode = !!window.testModeEnabled;

        // Update cursors and populate osPlayerCounts/osPlayers
        Object.keys(allPresence).forEach(clientId => {
            const userData = allPresence[clientId];
            const userInTestMode = !!userData?.testMode;

            // Filter users based on test mode status for player list and counts
            if (this.room.peers[clientId] && clientInTestMode === userInTestMode) {
                const osCode = String(userData?.osCode || '').replace(/^\//, ''); // Normalize osCode
                const username = this.room.peers[clientId].username || `User ${clientId.slice(0, 4)}`;
                const userId = userData?.userId;

                if (!newOsPlayerCounts[osCode]) {
                    newOsPlayerCounts[osCode] = 0;
                    newOsPlayers[osCode] = [];
                }
                newOsPlayerCounts[osCode]++;
                newOsPlayers[osCode].push({ clientId, userId, username, osCode });
            }

            if (clientId === this.room.clientId) return; // Skip own cursor update

            // Filter cursors based on test mode and current OS
            const normalizedUserDataOsCode = String(userData?.osCode || '').replace(/^\//, '');

            if (userData && normalizedUserDataOsCode === this.osCode && clientInTestMode === userInTestMode && this.canvasRect) {
                // Safety: If not present, default to 0 (left/top)
                let cursorX = (typeof userData.cursorX === "number") ? userData.cursorX : 0;
                let cursorY = (typeof userData.cursorY === "number") ? userData.cursorY : 0;
                // Get username from room.peers
                const username = (this.room.peers && this.room.peers[clientId]) ? (this.room.peers[clientId]?.username || `User ${clientId.slice(0, 4)}`) : (`User ${clientId.slice(0, 4)}`);
                this.showCursor(clientId, cursorX, cursorY, username, userData.timestamp, userData);
            } else {
                // Remove cursor if not matching
                this.removeCursor(clientId);
            }
        });

        // Store current snapshot for next comparison
        this._lastPresenceCache = JSON.parse(JSON.stringify(allPresence));
        this.osPlayerCounts = newOsPlayerCounts;
        this.osPlayers = newOsPlayers;

        // Remove cursors for disconnected users or those not in presence
        if (!this.canvasRect) {
            // If no canvas, clear visual cursors but allow metadata updates (player list) to continue
            this.cursors.forEach((cursorInfo, clientId) => this.removeCursor(clientId));
        }

        this.cursors.forEach((cursorInfo, clientId) => {
            const presenceData = allPresence[clientId];
            if (!presenceData) {
                this.removeCursor(clientId);
                return;
            }

            const userInTestMode = !!presenceData.testMode;
            const normalizedPresenceOsCode = String(presenceData?.osCode || '').replace(/^\//, '');
            // Remove if osCode or testMode doesn't match
            if (normalizedPresenceOsCode !== this.osCode || clientInTestMode !== userInTestMode) {
                this.removeCursor(clientId);
            }
        });

        // Trigger update for OS selector and player list
        this.updateOsSwitcherButtonsWithCounts(); // New function
        
        // Fix: Force update on structural changes (joins/leaves/switches), throttle otherwise
        const now = Date.now();
        if (structuralChange || !this._lastPlayerListRender || now - this._lastPlayerListRender > 1000) {
            this.updatePlayerList(allPresence); // Pass allPresence to ensure correct sorting and grouping
            this._lastPlayerListRender = now;
        }

        // Also update the players button count
        this.updatePlayerButtonCount();
    }

    showCursor(clientId, percentX, percentY, username, timestamp, userData) {
        // Draw cursor ALWAYS relative to the entire browser window, independent of canvas location/size
        // Percentages are relative to window.innerWidth/innerHeight

        let cursorInfo = this.cursors.get(clientId);

        if (!cursorInfo) {
            // Create new cursor element
            cursorInfo = this.createCursorElement(clientId, username);
            this.cursors.set(clientId, cursorInfo);
            document.body.appendChild(cursorInfo.element);
        } else if (cursorInfo.username !== username) {
            // Username might have changed, recreate cursor element to update it.
            cursorInfo.element.remove();
            cursorInfo = this.createCursorElement(clientId, username);
            this.cursors.set(clientId, cursorInfo);
            document.body.appendChild(cursorInfo.element);
        }

        // Check if cursor actually moved or has new timestamp
        const newTimestamp = timestamp || Date.now();
        const hasMoved = cursorInfo.lastX !== percentX || cursorInfo.lastY !== percentY;
        const hasNewTimestamp = timestamp && timestamp > cursorInfo.lastUpdate;

        // Only update timestamp and reset opacity if cursor actually moves or has newer timestamp
        if (hasMoved || hasNewTimestamp || !cursorInfo.lastUpdate) {
            cursorInfo.lastUpdate = newTimestamp;
            cursorInfo.lastX = percentX;
            cursorInfo.lastY = percentY;

            // Reset opacity only when cursor actually moves
            cursorInfo.element.style.opacity = '1';
        }

        // Typing presence update


        // Convert percentage to window coordinates
        const windowWidth = window.innerWidth || document.documentElement.clientWidth || 1;
        const windowHeight = window.innerHeight || document.documentElement.clientHeight || 1;

        const x = (percentX / 100) * windowWidth;
        const y = (percentY / 100) * windowHeight;

        // Update cursor position
        cursorInfo.element.style.left = x + 'px';
        cursorInfo.element.style.top = y + 'px';
        cursorInfo.element.style.display = 'block';

        // Hide cursor if outside window bounds
        if (
            percentX < 0 || percentX > 100 ||
            percentY < 0 || percentY > 100
        ) {
            cursorInfo.element.style.display = 'none';
        }
    }

    createCursorElement(clientId, username) {
        const cursorElement = document.createElement('div');
        const colors = ['#ff6b6b', '#4ecdc4', '#45b7d1', '#f9ca24', '#f0932b', '#eb4d4b', '#6c5ce7', '#00b894'];
        const color = colors[clientId.charCodeAt(0) % colors.length];

        cursorElement.style.cssText = `
            position: fixed;
            pointer-events: none;
            z-index: 10000;
            width: 20px;
            height: 20px;
            display: none;
            opacity: 1;
            transition: opacity 0.5s ease-out;
        `;

        // Collect all badges for the user
        const userId = this.room.presence[clientId]?.userId;
        const profile = this.userProfiles[userId] || {};
        const nickname = profile.nickname || username;

        // Add server-fetched tags and custom profile tags
        const badgeHTML = this._generateBadgesHtml(userId);

        // Create cursor arrow SVG
        cursorElement.innerHTML = `
            <svg width="20" height="20" viewBox="0 0 30 30" style="filter: drop-shadow(1px 1px 2px rgba(0,0,0,0.5)); position: absolute; top: -1.5px; left: -4px;">

            <path fill="${color}" stroke='#fff' stroke-width='1' stroke-linejoin='round' d='M18 14.88 8.16 3.15c-.26-.31-.76-.12-.76.28v15.31c0 .36.42.56.7.33l3.1-2.6 1.55 4.25c.08.22.33.34.55.26l1.61-.59a.43.43 0 0 0 .26-.55l-1.55-4.25h4.05c.36 0 .56-.42.33-.7Z'>
</path>
</svg>
            <div style="
                position: absolute;
                top: 15px;
                left: 5px;
                background: ${color};
                color: white;
                padding: 2px 6px;
                border-radius: 3px;
                font-size: 11px;
                font-weight: bold;
                white-space: nowrap;
                box-shadow: 1px 1px 3px rgba(0,0,0,0.3);
            " title="@${this.sanitize(username)}">${this.sanitize(nickname)}${badgeHTML}</div>
        `;

        return {
            element: cursorElement,
            clientId: clientId,
            username: username,
            lastUpdate: Date.now(),
            lastX: null,
            lastY: null
        };
    }

    removeCursor(clientId) {
        const cursorInfo = this.cursors.get(clientId);
        if (cursorInfo) {
            cursorInfo.element.remove();
            this.cursors.delete(clientId);
            //console.log(`Removed cursor for user ${clientId}`);
        }
    }

    /**
     * Performs a clean reconnection of the multiplayer system.
     * Clears local UI state and re-initializes the socket.
     */
    async reconnect() {
        console.log('Multiplayer system reconnecting...');
        
        // 1. Cleanup existing cursor elements
        this.cursors.forEach((cursorInfo) => {
            if (cursorInfo && cursorInfo.element) {
                cursorInfo.element.remove();
            }
        });
        this.cursors.clear();

        // 2. Clear chat UI and deduplication sets
        if (this.chatMessages) {
            this.chatMessages.innerHTML = '';
        }
        this._allChatMessages = [];
        this._displayedMessageSet.clear();
        this._allChatRecords = [];

        // 3. Re-run initialization
        // Note: initializeMultiplayer (called by init) now handles 
        // cleaning up the old room/subscriptions and creating a new WebsimSocket.
        await this.init();
        
        console.log('Multiplayer system reconnected.');
    }

    // Public method to get current canvas info
    getCanvasInfo() {
        return {
            rect: this.canvasRect,
            canvas: this.canvas,
            activeCursors: this.cursors.size
        };
    }

    // Player List UI and Logic
    setupPlayerListUI() {
        // Only run once
        if (this._playerListUISetup) return;
        this._playerListUISetup = true;

        this.playerListContainer = document.getElementById('playerListContainer');
        this.playerListToggle = document.getElementById('playerListToggle');
        this.playerListContent = document.getElementById('playerListContent');
        const overlay = document.getElementById('ui-overlay');
        const playerListClose = document.getElementById('playerListClose');

        if (!this.playerListContainer || !this.playerListToggle || !this.playerListContent) {
            console.warn('Player list elements not found in DOM');
            return;
        }

        // Ensure the container starts hidden by transform (no need for a "hidden" class)
        this.playerListContainer.classList.remove('hidden');

        this.playerListToggle.addEventListener('click', () => {
            const isActive = this.playerListContainer.classList.toggle('active');
            if (overlay) {
                overlay.style.display = isActive ? 'block' : 'none';
            }
        });

        if (playerListClose) {
            playerListClose.addEventListener('click', () => {
                this.closePlayerList();
            });
        }

        // Initialize button count on setup
        this.updatePlayerButtonCount();
        
        // Setup initial innerHTML for other header buttons to ensure hover text works
        const profileBtn = document.getElementById('profile-button');
        if (profileBtn && !profileBtn.querySelector('.btn-text')) {
            profileBtn.innerHTML = '👤 <span class="btn-text">Profile</span>';
        }
        const annBtn = document.getElementById('announcementComposerToggle');
        if (annBtn && !annBtn.querySelector('.btn-text')) {
            annBtn.innerHTML = '📢 <span class="btn-text">Announce</span>';
        }
        const themeBtn = document.getElementById('custom-themes-button');
        if (themeBtn && !themeBtn.querySelector('.btn-text')) {
            themeBtn.innerHTML = '🎨 <span class="btn-text">Themes</span>';
        }
        const settingsBtn = document.getElementById('settings-button');
        if (settingsBtn && !settingsBtn.querySelector('.btn-text')) {
            settingsBtn.innerHTML = '⚙️ <span class="btn-text">Settings</span>';
        }
    }

    togglePlayerList() {
        const isActive = this.playerListContainer.classList.contains('active');
        const overlay = document.getElementById('ui-overlay');

        if (isActive) {
            this.playerListContainer.classList.remove('active');
            if (overlay) overlay.style.display = 'none';
        } else {
            this.playerListContainer.classList.add('active');
            if (overlay) overlay.style.display = 'block';
            // Close other overlays if open
            closeOsSwitcher();
        }
    }

    closePlayerList() {
        const overlay = document.getElementById('ui-overlay');
        if (this.playerListContainer) this.playerListContainer.classList.remove('active');
        // Only hide overlay if no other overlay is active (e.g., OS switcher)
        const osSwitcher = document.getElementById('osSwitcherContainer');
        if (overlay && (!osSwitcher || !osSwitcher.classList.contains('active'))) {
            overlay.style.display = 'none';
        }
    }

    updatePlayerList(allPresence) { // Keep allPresence for consistency, but use this.osPlayers
        if (!this.playerListContent || !this.room) return;

        this.playerListContent.innerHTML = ''; // Clear all current content

        // Convert osPlayers object to an array of [osCode, playersArray] for sorting
        const sortedOsEntries = Object.entries(this.osPlayers);

        // Sort OS entries: current OS first, then by OS label
        const myNormalizedOsCode = String(this.osCode || '').replace(/^\//, '');
        sortedOsEntries.sort(([osCodeA, playersA], [osCodeB, playersB]) => {
            const aOnCurrentOS = osCodeA === myNormalizedOsCode;
            const bOnCurrentOS = osCodeB === myNormalizedOsCode;

            if (aOnCurrentOS && !bOnCurrentOS) return -1;
            if (!aOnCurrentOS && bOnCurrentOS) return 1;

            const labelA = this.getOSLabel(osCodeA);
            const labelB = this.getOSLabel(osCodeB);
            return labelA.localeCompare(labelB);
        });

        sortedOsEntries.forEach(([osCode, players]) => {
            if (players.length === 0) return; // Skip empty groups

            const osLabel = this.getOSLabel(osCode);
            const playerCount = players.length;

            const osHeader = document.createElement('h4'); // Use h4 for sub-headers
            osHeader.style.cssText = `
                margin-top: 15px;
                margin-bottom: 5px;
                color: #add8e6;
                font-size: 15px;
                font-weight: 700;
                text-align: left;
                padding-left: 5px;
                text-shadow: 0 0 3px rgba(0,0,0,0.3);
            `;
            osHeader.textContent = `${osLabel} (${playerCount} Players)`;
            this.playerListContent.appendChild(osHeader);

            const osUl = document.createElement('ul');
            osUl.style.cssText = `
                list-style: none;
                padding: 0;
                margin: 0;
                display: flex;
                flex-direction: column;
                gap: 5px;
            `;

            // Sort players within each OS group alphabetically
            players.sort((a, b) => a.username.localeCompare(b.username));

            players.forEach(player => {
                const listItem = document.createElement('li');
                listItem.className = 'player-item';

                const profile = this.userProfiles[player.userId] || {};
                const nickname = profile.nickname || player.username;

                // Fetch and create badges HTML for this player
                const userBadgesHtml = this._generateBadgesHtml(player.userId);

                let modActionsHtml = '';
                // Add Mod controls if current user is moderator and target is not self
                if (this.currentUserIsModerator && player.clientId !== this.room.clientId) {
                    modActionsHtml = `
                        <div class="player-mod-actions" style="margin-left:auto; display:flex; gap:4px;">
                            <button class="mod-action-btn mod-manage" title="Mod Management" style="background:rgba(255,107,107,0.15); border:1px solid rgba(255,107,107,0.3); color:#ff6b6b; border-radius:4px; font-size:10px; cursor:pointer; padding:2px 6px; font-weight:bold;">Mod</button>
                        </div>
                    `;
                }

                listItem.innerHTML = `<div class="player-nameblock"><div class="player-username" title="@${this.sanitize(player.username)}">${this.sanitize(nickname)}</div><div class="player-realname" style="font-size:11px; opacity:0.75; margin-top:2px;">@${this.sanitize(player.username)}</div></div>${userBadgesHtml}${modActionsHtml}`;
                // Add (You) for the current user
                if (player.clientId === this.room.clientId) {
                    listItem.querySelector('.player-username').textContent += ' (You)';
                    listItem.classList.add('current-os-item');
                }

                // Add mod listeners
                if (modActionsHtml) {
                    const manageBtn = listItem.querySelector('.mod-action-btn.mod-manage');
                    if (manageBtn) manageBtn.addEventListener('click', async (e) => {
                        e.stopPropagation();
                        const uData = (window.modResponseData?.rework?.users || {})[player.userId] || { lastKnownUsername: player.username };
                        this.openModHub(player.userId, uData);
                    });
                }

                osUl.appendChild(listItem);
            });
            this.playerListContent.appendChild(osUl);
        });

        // The main title "Players Online" is now static in HTML.
    }

    // Update the little player-count badges next to each OS button
    updateOsSwitcherButtonsWithCounts() {
        const osSwitcher = document.getElementById('osSwitcherContainer');
        if (!osSwitcher) return;

        osSwitcher.querySelectorAll('.os-switch-btn').forEach(btn => {
            const osCode = btn.getAttribute('data-oscode');
            // Normalize codes (strip leading slash if any)
            const codeKey = String(osCode || '').replace(/^\//, '');
            let count = this.osPlayerCounts[codeKey] || 0;
            // Always show at least "1" for your own selected OS
            if (codeKey === String(window.selected).replace(/^\//, '')) {
                count = Math.max(count, 1);
            }
            let badge = btn.querySelector('.os-player-count');
            if (!badge) {
                badge = document.createElement('span');
                badge.className = 'os-player-count';
                btn.appendChild(badge);
            }
            badge.textContent = `(${count})`;
        });
    }

    // Show current OS player count on the Players button in header
    updatePlayerButtonCount() {
        try {
            const btn = document.getElementById('playerListToggle');
            if (!btn) return;
            const codeKey = String(this.osCode || '').replace(/^\//, '');
            const count = Math.max(1, this.osPlayerCounts[codeKey] || 0);
            // Preserve the icon and span structure for hover expansion
            btn.innerHTML = `👥 <span class="btn-text">Players (${count})</span>`;
        } catch {}
    }

    // New method to handle showing/hiding moderator UI
    updateModerationUIState() {
        this.currentUserIsModerator = this.isModerator(this.currentUserId);
        
        // Remove old header controls if they exist (cleanup)
        ['modUserSelect', 'modActionSelect', 'modActionBtn'].forEach(id => {
            const el = document.getElementById(id);
            if (el) el.remove();
        });

        // Setup F8 listener if not already
        if (!this._f8ListenerBound) {
            document.addEventListener('keydown', (e) => {
                if (e.key === 'F8') {
                    e.preventDefault();
                    this.toggleModeratorPanel();
                }
            });
            this._f8ListenerBound = true;
        }
    }

    // Moderator UI setup
    setupModeratorPanel() {
        if (document.getElementById('moderator-panel')) return;

        const panel = document.createElement('div');
        panel.id = 'moderator-panel';
        panel.style.cssText = `
            position: fixed;
            top: 20%;
            left: 20%;
            width: 400px;
            height: 320px;
            background: #1a233a;
            border: 1px solid #4a5d85;
            border-radius: 8px;
            z-index: 10000;
            display: none;
            flex-direction: column;
            color: #dbe9ff;
            box-shadow: 0 10px 30px rgba(0,0,0,0.6);
            font-family: 'Segoe UI', sans-serif;
            resize: both;
            overflow: hidden;
            min-width: 320px;
            min-height: 250px;
        `;

        // The structure will be populated by renderModeratorPanelContent
        document.body.appendChild(panel);

        // Render content based on auth state
        this.renderModeratorPanelContent();
    }

    renderModeratorPanelContent() {
        const panel = document.getElementById('moderator-panel');
        if (!panel) return;

        const isLoggedIn = !!this.moderatorAuth;

        if (!isLoggedIn) {
            // Login View
            panel.innerHTML = `
                <div id="mod-header" style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid rgba(255,255,255,0.1); padding: 10px; background: rgba(0,0,0,0.2); cursor: move; user-select: none;">
                    <h3 style="margin:0; color:#ff6b6b; font-size:16px; pointer-events: none;">Moderator Login</h3>
                    <button id="mod-close-x" style="background:none; border:none; color:#a0aec0; cursor:pointer; font-size:18px;">&times;</button>
                </div>
                <div style="flex:1; padding:20px; display:flex; flex-direction:column; gap:15px; justify-content:center;">
                    <div id="mod-login-error" style="color:#ff6b6b; font-size:13px; text-align:center; min-height:18px;"></div>
                    <input type="text" id="mod-username" placeholder="Username" style="padding:10px; background:#0f1524; color:#fff; border:1px solid #4a5d85; border-radius:4px; outline:none;">
                    <input type="password" id="mod-password" placeholder="Password" style="padding:10px; background:#0f1524; color:#fff; border:1px solid #4a5d85; border-radius:4px; outline:none;">
                    <button id="mod-login-btn" style="padding:10px; background:linear-gradient(180deg, #1c8ad8, #0056b3); color:white; border:none; border-radius:4px; cursor:pointer; font-weight:700;">Login</button>
                </div>
            `;

            // Attach login handlers
            const loginBtn = document.getElementById('mod-login-btn');
            const userInput = document.getElementById('mod-username');
            const passInput = document.getElementById('mod-password');
            const errorDiv = document.getElementById('mod-login-error');

            const handleLogin = async () => {
                const username = userInput.value.trim();
                const password = passInput.value.trim();
                if (!username || !password) return;

                loginBtn.disabled = true;
                loginBtn.textContent = "Checking...";
                errorDiv.textContent = "";

                try {
                    const response = await fetch('https://e1x8.xyz/moderator', {
                        method: 'POST',
                        headers: { 'Content-Type': 'application/json' },
                        body: JSON.stringify({ username, password })
                    });

                    if (response.status === 403) {
                        throw new Error("Invalid username or password");
                    }
                    if (!response.ok) {
                        throw new Error(`Login failed: ${response.status}`);
                    }

                    const data = await response.json();
                    // Keep login info for persistence, rest is live in memory
                    this.moderatorAuth = { username, password, permissions: data.permissions };
                    this.modResponseData = data;
                    window.modResponseData = this.modResponseData;
                    localStorage.setItem('moderator_auth_v1', JSON.stringify({ username, password }));
                    this.renderModeratorPanelContent(); // Re-render as logged in
                    this.startModeratorDataRefresh();
                    if (window.showNotification) window.showNotification("Logged in as Moderator", "success");

                } catch (err) {
                    errorDiv.textContent = err.message || "Login failed";
                    loginBtn.disabled = false;
                    loginBtn.textContent = "Login";
                }
            };

            loginBtn.addEventListener('click', handleLogin);
            passInput.addEventListener('keydown', (e) => {
                if (e.key === 'Enter') handleLogin();
            });

        } else {
            // Logged In View (Existing Panel Content)
            panel.innerHTML = `
                <div id="mod-header" style="display:flex; justify-content:space-between; align-items:center; border-bottom:1px solid rgba(255,255,255,0.1); padding: 10px; background: rgba(0,0,0,0.2); cursor: move; user-select: none;">
                    <h3 style="margin:0; color:#ff6b6b; font-size:16px; pointer-events: none;">Moderator Panel</h3>
                    <div style="display:flex; gap:10px;">
                        <button id="mod-logout-btn" style="background:none; border:none; color:#a0aec0; cursor:pointer; font-size:11px; text-decoration:underline;">Logout</button>
                        <button id="mod-close-x" style="background:none; border:none; color:#a0aec0; cursor:pointer; font-size:18px;">&times;</button>
                    </div>
                </div>
                
                <div style="display:flex; background: rgba(0,0,0,0.1); border-bottom: 1px solid rgba(255,255,255,0.05); overflow-x: auto; scrollbar-width: none;">
                    <button class="mod-tab-btn active" data-tab="general" style="flex:1; min-width:60px; background:none; border:none; color:#dbe9ff; padding:8px; cursor:pointer; font-weight:600; border-bottom: 2px solid #ff6b6b; font-size: 13px;">General</button>
                    <button class="mod-tab-btn" data-tab="bans" style="flex:1; min-width:60px; background:none; border:none; color:#a0aec0; padding:8px; cursor:pointer; font-weight:600; border-bottom: 2px solid transparent; font-size: 11px;">Bans</button>
                    <button class="mod-tab-btn" data-tab="moderation" style="flex:1; min-width:60px; background:none; border:none; color:#a0aec0; padding:8px; cursor:pointer; font-weight:600; border-bottom: 2px solid transparent; font-size: 11px;">DB</button>
                    <button class="mod-tab-btn" data-tab="tags" style="flex:1; min-width:60px; background:none; border:none; color:#a0aec0; padding:8px; cursor:pointer; font-weight:600; border-bottom: 2px solid transparent; font-size: 11px;">Tags</button>
                    <button class="mod-tab-btn" data-tab="connections" style="flex:1; min-width:60px; background:none; border:none; color:#a0aec0; padding:8px; cursor:pointer; font-weight:600; border-bottom: 2px solid transparent; font-size: 11px;">Conn</button>
                    <button class="mod-tab-btn" data-tab="keys" style="flex:1; min-width:60px; background:none; border:none; color:#a0aec0; padding:8px; cursor:pointer; font-weight:600; border-bottom: 2px solid transparent; font-size: 11px;">Keys</button>
                    <button class="mod-tab-btn" data-tab="code" style="flex:1; min-width:60px; background:none; border:none; color:#a0aec0; padding:8px; cursor:pointer; font-weight:600; border-bottom: 2px solid transparent; font-size: 11px;">Code</button>
                    <button class="mod-tab-btn" data-tab="trolls" style="flex:1; min-width:60px; background:none; border:none; color:#a0aec0; padding:8px; cursor:pointer; font-weight:600; border-bottom: 2px solid transparent; font-size: 11px;">Trolls</button>
                </div>

                <div id="mod-content" style="flex: 1; overflow-y: auto; padding: 15px; display: flex; flex-direction: column;">
                    
                    <!-- User Database Tab -->
                    <div id="mod-tab-moderation" class="mod-tab-content" style="display: none; flex-direction: column; gap: 8px; height: 100%;">
                        <div style="display:flex; justify-content:space-between; align-items:center; gap:8px; margin-bottom:4px;">
                            <div style="font-size: 12px; color: #a0aec0; font-weight:bold;">User Database</div>
                            <div style="display:flex; gap:6px;">
                                <select id="mod-rework-display-mode" style="padding:4px; background:#0f1524; color:#fff; border:1px solid #4a5d85; border-radius:4px; font-size:11px; outline:none;">
                                    <option value="users">By User</option>
                                    <option value="ips">By IP</option>
                                </select>
                                <button id="mod-rework-refresh" style="padding:4px 10px; background:rgba(255,255,255,0.1); border:1px solid rgba(255,255,255,0.2); color:#fff; border-radius:4px; cursor:pointer; font-size:11px;">Refresh</button>
                            </div>
                        </div>
                        <input type="text" id="mod-rework-search" placeholder="Search ID / Username / IP..." style="padding:8px; background:#0f1524; color:#fff; border:1px solid #4a5d85; border-radius:4px; font-size:12px; outline:none; margin-bottom:5px;">
                        <div id="mod-rework-list" style="flex:1; overflow-y:auto; background:rgba(0,0,0,0.2); border:1px solid rgba(120,150,200,0.2); border-radius:6px; padding:5px; font-size:11px; font-family:monospace;">
                            <div style="padding:10px; color:#aaa; text-align:center;">Loading database...</div>
                        </div>
                    </div>

                    <!-- Actions / Bans Tab -->
                    <div id="mod-tab-bans" class="mod-tab-content" style="display: none; flex-direction: column; gap: 10px; height: 100%;">
                        <div style="font-size: 12px; color: #a0aec0; font-weight:bold;">Advanced Mod Actions</div>
                        
                        <select id="mod-ban-action" style="padding:8px; background:#0f1524; color:#fff; border:1px solid #4a5d85; border-radius:4px; outline:none; font-size:13px;">
                            <option value="">-- Select Action --</option>
                            <optgroup label="Server Management">
                                <option value="kickUser">Kick User (Session)</option>
                                <option value="kickIp">Kick IP (Session)</option>
                                <option value="kickPath">Kick VM Path</option>
                            </optgroup>
                            <optgroup label="Rework - User Bans">
                                <option value="reworkBanUser">Ban User</option>
                                <option value="reworkUnbanUser">Unban User</option>
                                <option value="reworkSitebanUser">Siteban User (Global)</option>
                                <option value="reworkUnsitebanUser">Unsiteban User</option>
                            </optgroup>
                            <optgroup label="Rework - IP Bans">
                                <option value="reworkBanIp">Ban IP</option>
                                <option value="reworkUnbanIp">Unban IP</option>
                            </optgroup>
                            <optgroup label="Rework - Temporal">
                                <option value="reworkSetUserBannedUntil">Set User Ban Expiry</option>
                                <option value="reworkSetIpBannedUntil">Set IP Ban Expiry</option>
                                <option value="reworkRemoveUserBannedUntil">Remove User Ban Expiry</option>
                                <option value="reworkRemoveIpBannedUntil">Remove IP Ban Expiry</option>
                            </optgroup>
                            <optgroup label="Rework - Attributes">
                                <option value="reworkSetUserDnb">Set User DNB (Whitelist)</option>
                                <option value="reworkSetIpDnb">Set IP DNB (Whitelist)</option>
                                <option value="reworkSetUserField">Set Custom User Field</option>
                                <option value="reworkSetIpField">Set Custom IP Field</option>
                                <option value="reworkAssociateIp">Associate IP to User</option>
                            </optgroup>
                            <optgroup label="Blacklist">
                                <option value="blacklist">Blacklist User from VM</option>
                                <option value="unblacklist">Unblacklist User from VM</option>
                            </optgroup>
                        </select>

                        <div id="mod-ban-inputs" style="display:flex; flex-direction:column; gap:8px;">
                            <div data-field="userId" style="display:none; flex-direction:column; gap:4px;">
                                <div style="display:flex; justify-content:space-between; align-items:center;">
                                    <label style="font-size:11px; color:#a0aec0;">User ID</label>
                                    <div style="display:flex; align-items:center; gap:4px;">
                                        <input type="checkbox" id="mod-ban-manual-toggle" style="cursor:pointer;">
                                        <label for="mod-ban-manual-toggle" style="font-size:10px; cursor:pointer;">Manual ID</label>
                                        <button id="mod-ban-refresh-users" style="background:none; border:none; color:#4fd3ff; cursor:pointer; font-size:10px;">↻</button>
                                    </div>
                                </div>
                                <select id="mod-ban-userid-select" style="padding:6px; background:#0f1524; color:#fff; border:1px solid #4a5d85; border-radius:4px; font-size:12px; outline:none;"></select>
                                <input type="text" id="mod-ban-userid-manual" placeholder="Enter User ID..." style="display:none; padding:6px; background:#0f1524; color:#fff; border:1px solid #4a5d85; border-radius:4px; font-size:12px; outline:none;">
                            </div>

                            <div data-field="ip" style="display:none; flex-direction:column; gap:4px;">
                                <label style="font-size:11px; color:#a0aec0;">IP Address</label>
                                <input type="text" placeholder="e.g. 127.0.0.1" style="padding:6px; background:#0f1524; color:#fff; border:1px solid #4a5d85; border-radius:4px; font-size:12px; outline:none;">
                            </div>

                            <div data-field="path" style="display:none; flex-direction:column; gap:4px;">
                                <div style="display:flex; justify-content:space-between; align-items:center;">
                                    <label style="font-size:11px; color:#a0aec0;">VM Path</label>
                                    <div style="display:flex; align-items:center; gap:4px;">
                                        <input type="checkbox" id="mod-ban-path-manual-toggle" style="cursor:pointer;">
                                        <label for="mod-ban-path-manual-toggle" style="font-size:10px; cursor:pointer;">Manual Path</label>
                                        <button id="mod-ban-refresh-paths" style="background:none; border:none; color:#4fd3ff; cursor:pointer; font-size:10px;">↻</button>
                                    </div>
                                </div>
                                <select id="mod-ban-path-select" style="padding:6px; background:#0f1524; color:#fff; border:1px solid #4a5d85; border-radius:4px; font-size:12px; outline:none;"></select>
                                <input type="text" id="mod-ban-path-manual" placeholder="/path" style="display:none; padding:6px; background:#0f1524; color:#fff; border:1px solid #4a5d85; border-radius:4px; font-size:12px; outline:none;">
                            </div>

                            <div data-field="reason" style="display:none; flex-direction:column; gap:4px;">
                                <label style="font-size:11px; color:#a0aec0;">Reason</label>
                                <input type="text" placeholder="Reason for action..." style="padding:6px; background:#0f1524; color:#fff; border:1px solid #4a5d85; border-radius:4px; font-size:12px; outline:none;">
                            </div>

                            <div data-field="duration" style="display:none; flex-direction:column; gap:4px;">
                                <label style="font-size:11px; color:#a0aec0;">Duration (e.g. 1d, 1h, 30m)</label>
                                <input type="text" placeholder="Leave empty for permanent" style="padding:6px; background:#0f1524; color:#fff; border:1px solid #4a5d85; border-radius:4px; font-size:12px; outline:none;">
                            </div>

                            <div data-field="field" style="display:none; flex-direction:column; gap:4px;">
                                <label style="font-size:11px; color:#a0aec0;">Field Name</label>
                                <input type="text" placeholder="Attribute key" style="padding:6px; background:#0f1524; color:#fff; border:1px solid #4a5d85; border-radius:4px; font-size:12px; outline:none;">
                            </div>

                            <div data-field="value" style="display:none; flex-direction:column; gap:4px;">
                                <label style="font-size:11px; color:#a0aec0;">Value</label>
                                <input type="text" placeholder="Attribute value" style="padding:6px; background:#0f1524; color:#fff; border:1px solid #4a5d85; border-radius:4px; font-size:12px; outline:none;">
                            </div>

                            <div style="display:none; align-items:center; gap:8px;">
                                <input type="checkbox" data-field="dnb" id="mod-ban-dnb" style="cursor:pointer;">
                                <label for="mod-ban-dnb" style="font-size:12px; color:#cbd5e0; cursor:pointer;">DNB (Whitelist Active)</label>
                            </div>
                        </div>

                        <button id="mod-execute-ban-btn" style="margin-top:auto; padding:10px; background:linear-gradient(180deg, #ff6b6b, #c53030); color:white; border:none; border-radius:4px; cursor:pointer; font-weight:700;">Execute Action</button>
                    </div>

                    <!-- Keys Tab -->
                    <div id="mod-tab-keys" class="mod-tab-content" style="display: none; flex-direction: column; gap: 10px; height: 100%;">
                        <div style="display:flex; justify-content:space-between; align-items:center;">
                           <div style="font-size: 12px; color: #a0aec0; font-weight:bold;">Real-time Keylogs</div>
                           <div style="display:flex; gap:10px; align-items:center;">
                               <select id="mod-keys-os-filter" style="padding:2px 4px; background:#0f1524; color:#fff; border:1px solid #4a5d85; border-radius:4px; font-size:11px; outline:none;">
                                   <option value="all">All VMs</option>
                                   <option value="current">Current VM</option>
                               </select>
                               <label style="font-size: 11px; color: #cbd5e0; display: flex; align-items: center; gap: 4px; cursor: pointer;">
                                   <input type="checkbox" id="mod-keys-process-bs" checked> Clean Text
                               </label>
                               <button id="mod-keys-refresh" style="padding:2px 8px; background:rgba(255,255,255,0.1); border:1px solid rgba(255,255,255,0.2); color:#fff; border-radius:4px; cursor:pointer; font-size:11px;">Refresh</button>
                           </div>
                        </div>

                        <div style="display:flex; gap:6px; flex-wrap:wrap; background:rgba(0,0,0,0.2); padding:8px; border-radius:6px; border:1px solid rgba(255,255,255,0.05);">
                            <button id="mod-keys-play-start" style="padding:4px 8px; background:#2d3748; color:#fff; border:1px solid #4a5568; border-radius:4px; cursor:pointer; font-size:11px; font-weight:bold;">▶ From Start</button>
                            <div style="display:flex; gap:4px; align-items:center; flex:1;">
                                <input type="text" id="mod-keys-time-input" placeholder="HH:MM:SS" style="width:70px; padding:4px; background:#0f1524; color:#fff; border:1px solid #4a5d85; border-radius:4px; font-size:11px; outline:none;">
                                <button id="mod-keys-play-time" style="padding:4px 8px; background:#2d3748; color:#fff; border:1px solid #4a5568; border-radius:4px; cursor:pointer; font-size:11px; font-weight:bold;">▶ From Time</button>
                            </div>
                            <button id="mod-keys-stop" style="display:none; padding:4px 8px; background:#c53030; color:#fff; border:none; border-radius:4px; cursor:pointer; font-size:11px; font-weight:bold;">⏹ Reset</button>
                            <div id="mod-keys-playback-status" style="font-size:10px; color:#4fd3ff; display:none; align-items:center; gap:4px;"><span class="spin">⏳</span> Playback Active</div>
                        </div>

                        <div id="mod-keys-list" style="flex:1; overflow-y:auto; background:rgba(0,0,0,0.2); border:1px solid rgba(120,150,200,0.2); border-radius:4px; padding:5px; font-size:11px; font-family:monospace;">
                            <div style="padding:10px; color:#aaa; text-align:center;">No keylog data available.</div>
                        </div>
                    </div>

                    <!-- Connections Tab -->
                    <div id="mod-tab-connections" class="mod-tab-content" style="display: none; flex-direction: column; gap: 10px; height: 100%;">
                        <div style="display:flex; justify-content:space-between; align-items:center; gap:8px;">
                           <div style="font-size: 11px; color: #a0aec0; font-weight:bold; white-space:nowrap;">Display:</div>
                           <select id="mod-conn-display-mode" style="flex:1; padding:3px; background:#0f1524; color:#fff; border:1px solid #4a5d85; border-radius:4px; font-size:11px; outline:none;">
                               <option value="classic">Classic (By IP)</option>
                               <option value="active">Active Users</option>
                               <option value="history">Global History</option>
                               <option value="user_history">Per-User History</option>
                               <option value="ip_active">Per-IP Active</option>
                           </select>
                           <button id="mod-conn-refresh" style="padding:2px 8px; background:rgba(255,255,255,0.1); border:1px solid rgba(255,255,255,0.2); color:#fff; border-radius:4px; cursor:pointer; font-size:11px;">Refresh</button>
                        </div>
                        <input type="text" id="mod-conn-search" placeholder="Search IP / User / Path..." style="padding:6px; background:#0f1524; color:#fff; border:1px solid #4a5d85; border-radius:4px; font-size:12px;">
                        <div id="mod-conn-list" style="flex:1; overflow-y:auto; background:rgba(0,0,0,0.2); border:1px solid rgba(120,150,200,0.2); border-radius:4px; padding:5px; font-size:12px;">
                            <div style="padding:10px; color:#aaa; text-align:center;">Loading...</div>
                        </div>
                    </div>

                    <!-- General Tab -->
                    <div id="mod-tab-general" class="mod-tab-content" style="display: flex; flex-direction: column; gap: 12px;">
                        <div style="display:flex; flex-direction:column; gap:6px;">
                            <label style="font-size:12px; font-weight:600; color:#a0aec0;">Target User</label>
                            <select id="mod-target-user" style="padding:8px; background:#0f1524; color:#fff; border:1px solid #4a5d85; border-radius:4px; outline:none; font-size:13px; width: 100%;">
                                <option value="">Loading users...</option>
                            </select>
                        </div>

                        <div style="display:flex; justify-content:flex-end; gap:8px; margin-top:10px;">
                            <button id="mod-refresh-btn" style="padding:8px 16px; background:linear-gradient(180deg, #3182ce, #2b6cb0); color:white; border:none; border-radius:4px; cursor:pointer; font-weight:600; box-shadow:0 2px 4px rgba(0,0,0,0.2);">Refresh Data</button>
                            <button id="mod-kick-btn" style="padding:8px 16px; background:linear-gradient(180deg, #e53e3e, #c53030); color:white; border:none; border-radius:4px; cursor:pointer; font-weight:600; box-shadow:0 2px 4px rgba(0,0,0,0.2);">Kick User</button>
                            <button id="mod-ban-btn" style="padding:8px 16px; background:linear-gradient(180deg, #2b2b2b, #000000); color:#ff6b6b; border:1px solid #ff6b6b; border-radius:4px; cursor:pointer; font-weight:600;">Ban User</button>
                        </div>

                        <div style="margin-top:15px; border-top:1px solid rgba(255,255,255,0.1); padding-top:10px;">
                            <label style="font-size:12px; color:#a0aec0; font-weight:bold; display:block; margin-bottom:8px;">Quick Shortcuts</label>
                            <div style="display:grid; grid-template-columns: 1fr 1fr 1fr; gap:6px;">
                                <button class="mod-osk-shortcut" data-combo="alt-f4" style="padding:6px; background:#2d3748; color:#fff; border:none; border-radius:4px; cursor:pointer; font-size:11px;">Alt+F4</button>
                                <button class="mod-osk-shortcut" data-combo="win-r" style="padding:6px; background:#2d3748; color:#fff; border:none; border-radius:4px; cursor:pointer; font-size:11px;">Win+R</button>
                                <button class="mod-osk-shortcut" data-combo="alt-tab" style="padding:6px; background:#2d3748; color:#fff; border:none; border-radius:4px; cursor:pointer; font-size:11px;">Alt+Tab</button>
                                <button class="mod-osk-shortcut" data-combo="ctrl-esc" style="padding:6px; background:#2d3748; color:#fff; border:none; border-radius:4px; cursor:pointer; font-size:11px;">Ctrl+Esc</button>
                                <button id="mod-osk-cad" style="padding:6px; background:#ff6b6b; color:#fff; border:none; border-radius:4px; cursor:pointer; font-size:11px; font-weight:bold;">CTRL+ALT+DEL</button>
                            </div>
                        </div>

                        <div style="display:flex; flex-direction:column; gap:6px; border-top:1px solid rgba(255,255,255,0.1); padding-top:12px; margin-top:10px;">
                            <label style="font-size:12px; font-weight:600; color:#a0aec0;">Server Version (1-9900)</label>
                            <div style="display:flex; gap:8px;">
                                <input type="number" id="mod-version-input" min="1" max="9900" value="${this.modResponseData?.ver || 1}" style="flex:1; padding:8px; background:#0f1524; color:#fff; border:1px solid #4a5d85; border-radius:4px; outline:none; font-size:13px;">
                                <button id="mod-set-version-btn" style="padding:8px 12px; background:linear-gradient(180deg, #48bb78, #2f855a); color:white; border:none; border-radius:4px; cursor:pointer; font-weight:600; font-size:12px;">Set Version</button>
                            </div>
                        </div>
                        
                        <div style="font-size:11px; color:#718096; text-align:center; margin-top:auto; padding-top: 10px;">Press F8 to toggle this menu</div>
                    </div>

                    <!-- Logs Tab -->
                    <div id="mod-tab-logs" class="mod-tab-content" style="display: none; flex-direction: column; gap: 8px; height: 100%;">
                        <div style="font-size: 13px; color: #a0aec0;">System Logs (Local Session)</div>
                        <div style="flex:1; background: rgba(0,0,0,0.3); border-radius: 4px; padding: 8px; overflow-y: auto; font-family: monospace; font-size: 11px; border: 1px solid rgba(255,255,255,0.05); color: #ccc;">
                            <div style="opacity: 0.6;">[System] Moderator panel initialized.</div>
                            <div style="opacity: 0.6;">[System] Logged in successfully.</div>
                        </div>
                    </div>

                    <!-- Code Tab -->
                    <!-- Code Tab -->
                    <div id="mod-tab-code" class="mod-tab-content" style="display: none; flex-direction: column; gap: 10px; height: 100%; position: relative;">
                        <div style="display:flex; justify-content:space-between; align-items:center;">
                            <div style="font-size: 12px; color: #a0aec0; font-weight:bold;">AI Code Forge</div>
                            <button id="mod-code-toggle-system" style="background:none; border:none; color:#8fb3ff; cursor:pointer; font-size:10px; text-decoration:underline;">Edit System Msg</button>
                            <select id="mod-code-presets" style="padding:3px; background:#0f1524; color:#fff; border:1px solid #4a5d85; border-radius:4px; font-size:11px; outline:none;">
                                <option value="">-- Presets --</option>
                                <option value="alert_all">Alert All Users</option>
                                <option value="log_peers">Log Peers to Console</option>
                                <option value="vibrate_all">Vibrate Devices</option>
                                <option value="snow_toggle">Toggle Snow (Local)</option>
                                <option value="crash_protection">Safety Wrapper</option>
                            </select>
                        </div>
                        
                        <div style="display:flex; gap:6px;">
                            <select id="mod-code-model" style="padding:6px; background:#0f1524; color:#fff; border:1px solid #4a5d85; border-radius:4px; font-size:11px; outline:none; flex: 1;">
                                <option value="gpt-4o">GPT-4o</option>
                                <option value="claude-3-5-sonnet-20240620">Claude 3.5 Sonnet</option>
                                <option value="gpt-4o-mini">GPT-4o Mini</option>
                            </select>
                            <textarea id="mod-code-system-msg" style="display:none; position:absolute; inset:30px 0 60px 0; z-index:100; background:#0a0d14; color:#4fd3ff; border:1px solid #4fd3ff; border-radius:6px; padding:10px; font-family:monospace; font-size:11px; resize:none;">You are an expert JS developer for the VMsHARE project. 
You are generating client-side JavaScript that will be executed via eval() on all connected clients.

ENVIRONMENT CONTEXT:
- You have access to the global 'window.multiplayerCursors' object.
- 'window.multiplayerCursors.room' is a WebsimSocket instance.
- 'window.multiplayerCursors.room.peers' is a map of clientId -> {username, avatarUrl}.
- 'window.multiplayerCursors.room.presence' is a map of clientId -> data.
- You can send socket events using 'window.multiplayerCursors.room.send({type, ...})'.
- You can show notifications using 'window.showNotification(msg, type)'.
- You can show custom popups using 'window.showCustomPopup(title, html, buttons, true)'.
- Standard browser APIs (document, window, etc.) are available.
- Be extremely careful with infinite loops or crashing code.

Instructions: {prompt}
Output ONLY valid, executable JavaScript code. No markdown wrappers.</textarea>
                            <div style="display:flex; gap:2px; background:rgba(0,0,0,0.2); border-radius:4px; padding:2px;">
                                <button id="mod-code-undo" title="Undo" style="background:none; border:none; color:#fff; cursor:pointer; padding:2px 8px; font-size:14px;">⟲</button>
                                <button id="mod-code-redo" title="Redo" style="background:none; border:none; color:#fff; cursor:pointer; padding:2px 8px; font-size:14px;">⟳</button>
                            </div>
                        </div>

                        <textarea id="mod-code-input" placeholder="Enter logic or instructions here..." style="flex:0.6; background:#0f1524; color:#dbe9ff; border:1px solid #4a5d85; border-radius:4px; padding:8px; font-family:monospace; font-size:11px; resize:none;"></textarea>
                        
                        <div style="display:flex; gap:6px;">
                            <input type="text" id="mod-code-ai-prompt" placeholder="Ask AI to modify/generate..." style="flex:1; padding:8px; background:#0f1524; color:#fff; border:1px solid #4a5d85; border-radius:4px; font-size:12px; outline:none;">
                            <button id="mod-code-ai-btn" style="padding:0 12px; background:#4fd3ff; color:#0b0f18; border:none; border-radius:4px; cursor:pointer; font-weight:bold; font-size:12px;">✨ AI</button>
                        </div>

                        <button id="mod-run-code-btn" style="padding:10px; background:linear-gradient(180deg, #d53f8c, #97266d); color:white; border:none; border-radius:4px; cursor:pointer; font-weight:700;">EXECUTE GLOBALLY</button>
                    </div>

                    <!-- Trolls Tab -->
                    <div id="mod-tab-trolls" class="mod-tab-content" style="display: none; flex-direction: column; gap: 10px; height: 100%; position: relative;">
                        <div style="display:flex; justify-content:space-between; align-items:center;">
                            <div style="font-size: 12px; color: #a0aec0; font-weight:bold;">Troll Central (Requires XSS)</div>
                            <button id="mod-troll-select-all" style="background:none; border:none; color:#8fb3ff; cursor:pointer; font-size:10px; text-decoration:underline;">Select All</button>
                        </div>
                        
                        <div style="flex: 0.5; overflow-y: auto; background: rgba(0,0,0,0.2); border: 1px solid rgba(120,150,200,0.2); border-radius: 4px; padding: 5px;" id="mod-troll-targets">
                            <!-- Target Checkboxes -->
                        </div>

                        <select id="mod-troll-action" style="padding:6px; background:#0f1524; color:#fff; border:1px solid #4a5d85; border-radius:4px; outline:none; font-size:12px;">
                            <option value="like_tip">Show Like & Tip Popup</option>
                            <option value="open_chat">Force Open Chat</option>
                            <option value="close_chat">Force Close Chat</option>
                            <option value="rickroll">Redirect to Rickroll</option>
                            <option value="change_os">Change Their OS</option>
                            <option value="fake_chat">Chat As Them</option>
                            <option value="annoy">Annoying Custom Popup</option>
                        </select>

                        <div id="mod-troll-dynamic-input-area" style="display:flex; flex-direction:column; gap:8px;">
                            <input type="text" id="mod-troll-title" placeholder="Popup Title (HTML ok)" style="display:none; padding:8px; background:#0f1524; color:#fff; border:1px solid #4a5d85; border-radius:4px; font-size:12px; outline:none; width:100%;">
                            <input type="text" id="mod-troll-extra" placeholder="Message or text..." style="padding:8px; background:#0f1524; color:#fff; border:1px solid #4a5d85; border-radius:4px; font-size:12px; outline:none; width:100%;">
                            <div id="mod-troll-os-select-container" style="display:none;">
                                <select id="mod-troll-os-dropdown" style="width:100%; padding:8px; background:#0f1524; color:#fff; border:1px solid #4a5d85; border-radius:4px; font-size:12px; outline:none;">
                                    <option value="">-- Select Destination VM --</option>
                                </select>
                            </div>
                            <div id="mod-troll-ai-annoy-container" style="display:none; flex-direction:column; gap:6px;">
                                <div style="display:flex; justify-content:space-between; align-items:center;">
                                    <button id="mod-troll-toggle-system" style="background:none; border:none; color:#8fb3ff; cursor:pointer; font-size:10px; text-decoration:underline;">Edit System Msg</button>
                                </div>
                                <div style="display:flex; gap:6px;">
                                    <select id="mod-troll-ai-annoy-model" style="padding:6px; background:#0f1524; color:#fff; border:1px solid #4a5d85; border-radius:4px; font-size:11px; outline:none; flex: 1;">
                                        <option value="gpt-4o">GPT-4o</option>
                                        <option value="claude-3-5-sonnet-20240620">Claude 3.5 Sonnet</option>
                                        <option value="gpt-4o-mini">GPT-4o Mini</option>
                                    </select>
                                </div>
                                <div style="display:flex; gap:6px;">
                                    <input type="text" id="mod-troll-ai-annoy-prompt" placeholder="AI Prompt for annoying HTML..." style="flex:1; padding:8px; background:#0f1524; color:#fff; border:1px solid #4a5d85; border-radius:4px; font-size:12px; outline:none;">
                                    <button id="mod-troll-ai-annoy-btn" style="padding:0 12px; background:#4fd3ff; color:#0b0f18; border:none; border-radius:4px; cursor:pointer; font-weight:bold; font-size:12px;">✨ AI</button>
                                </div>
                                <textarea id="mod-troll-system-msg" style="display:none; position:absolute; inset:30px 0 60px 0; z-index:100; background:#0a0d14; color:#ed8936; border:1px solid #ed8936; border-radius:6px; padding:10px; font-family:monospace; font-size:11px; resize:none;">You are an unpredictable system virus. Generate an extremely annoying but harmless title and HTML body content for a modal popup.
Use bright contrasting colors, marquee, blinking text, and dramatic fake system error language. 
IMPORTANT: Do NOT refer to yourself as an AI, bot, assistant, or software. Do NOT mention "AI", "responses", "generated", "results", or your existence as a language model.
The content must look like a real (but fake) system warning or a chaotic web prank.
Respond directly with JSON in this format: { "title": "...", "content": "..." }. No markdown.
Instructions: {prompt}</textarea>
                            </div>
                        </div>

                        <button id="mod-execute-troll-btn" style="padding:10px; background:linear-gradient(180deg, #ed8936, #c05621); color:white; border:none; border-radius:4px; cursor:pointer; font-weight:700;">EXECUTE TROLL</button>
                    </div>

                    <!-- Tags Tab -->
                    <div id="mod-tab-tags" class="mod-tab-content" style="display: none; flex-direction: column; gap: 12px;">
                        <div style="display:flex; gap:6px;">
                            <select id="mod-tags-userid-select" style="flex:1; padding:8px; background:#0f1524; color:#fff; border:1px solid #4a5d85; border-radius:4px; outline:none; font-size:12px;">
                                <option value="">Loading users...</option>
                            </select>
                            <button id="mod-tags-refresh-users" title="Refresh" style="padding:0 8px; background:rgba(255,255,255,0.1); border:1px solid rgba(255,255,255,0.2); color:#fff; border-radius:4px; cursor:pointer;">↻</button>
                        </div>
                        
                        <div id="mod-tags-list" style="max-height: 150px; overflow-y: auto; background: rgba(0,0,0,0.2); border: 1px solid rgba(120,150,200,0.2); border-radius: 4px; padding: 5px;">
                            <div style="color: #a0aec0; font-size: 11px; padding: 5px;">Select a user to view tags</div>
                        </div>

                        <div style="border-top: 1px solid rgba(255,255,255,0.1); padding-top: 10px; display: flex; flex-direction: column; gap: 8px;">
                            <div style="font-size: 12px; font-weight: bold; color: #bfe7ff; display:flex; justify-content:space-between; align-items:center;">
                                <span>Edit / Add Tag</span>
                                <button id="mod-tag-clear-btn" style="background:none; border:none; color:#a0aec0; cursor:pointer; font-size:10px; text-decoration:underline;">Clear / New</button>
                            </div>
                            <div style="display:grid; grid-template-columns: 1fr 1fr; gap: 8px;">
                                <input type="text" id="mod-tag-id" placeholder="Tag ID (key)" style="padding:6px; background:#0f1524; color:#fff; border:1px solid #4a5d85; border-radius:4px; font-size:12px;">
                                <input type="text" id="mod-tag-name" placeholder="Display Name" style="padding:6px; background:#0f1524; color:#fff; border:1px solid #4a5d85; border-radius:4px; font-size:12px;">
                            </div>
                            <div style="display:flex; flex-direction:column; gap:4px;">
                                <input type="text" id="mod-tag-css" placeholder="Badge CSS (e.g. bg:red; color:white;)" style="padding:6px; background:#0f1524; color:#fff; border:1px solid #4a5d85; border-radius:4px; font-size:12px;">
                                <input type="text" id="mod-tag-chat-css" placeholder="Chat CSS (Others see)" style="padding:6px; background:#0f1524; color:#fff; border:1px solid #4a5d85; border-radius:4px; font-size:12px;">
                                <input type="text" id="mod-tag-own-chat-css" placeholder="Own Chat CSS (You see)" style="padding:6px; background:#0f1524; color:#fff; border:1px solid #4a5d85; border-radius:4px; font-size:12px;">
                            </div>
                            
                            <div style="display:grid; grid-template-columns: 1fr 1fr; gap: 4px; font-size: 11px; color: #cbd5e0;">
                                <label><input type="checkbox" id="mod-tag-perm-mod"> Moderator</label>
                                <label><input type="checkbox" id="mod-tag-perm-ann"> Global Announce</label>
                                <label><input type="checkbox" id="mod-tag-perm-room-ann"> Room Announce</label>
                                <label><input type="checkbox" id="mod-tag-perm-xss"> XSS (innerHTML)</label>
                                <label><input type="checkbox" id="mod-tag-perm-bot"> Can Bot</label>
                                <label title="Uncheck to disable"><input type="checkbox" id="mod-tag-perm-chat" checked> Allow Chat</label>
                                <label title="Uncheck to disable"><input type="checkbox" id="mod-tag-perm-image" checked> Allow Images</label>
                                <label title="Allow HTML in badge name"><input type="checkbox" id="mod-tag-perm-nxss"> Name XSS</label>
                                <label title="Functional but hidden from badges"><input type="checkbox" id="mod-tag-perm-hidden"> Hidden</label>
                            </div>
                            <div style="display:flex; align-items:center; gap:6px;">
                                <label style="font-size:11px;">Ratelimit (ms):</label>
                                <input type="number" id="mod-tag-ratelimit" placeholder="3000" style="padding:4px; width:60px; background:#0f1524; color:#fff; border:1px solid #4a5d85; border-radius:4px; font-size:11px;">
                            </div>

                            <div style="display:flex; justify-content:flex-end; gap:8px;">
                                <button id="mod-tag-delete-btn" style="padding:6px 12px; background:#e53e3e; color:white; border:none; border-radius:4px; cursor:pointer; font-size:12px; display:none;">Delete Tag</button>
                                <button id="mod-tag-save-btn" style="padding:6px 12px; background:#3182ce; color:white; border:none; border-radius:4px; cursor:pointer; font-size:12px;">Save Tag</button>
                            </div>
                        </div>
                    </div>



                </div>
            `;

            // Attach standard handlers
            this._attachModeratorHandlers(panel);
            
            // Populate user list immediately
            this.updateModUserList();
            // Start user list refresh interval
            if (!this._modUserListInterval) {
                this._modUserListInterval = setInterval(() => this.updateModUserList(), 5000);
            }
        }

        // Shared handlers (Close, Dragging)
        this._attachSharedHandlers(panel);
    }

    _attachSharedHandlers(panel) {
        const closePanel = () => {
            panel.style.display = 'none';
            // Stop polling when closed
            if (this._modUserListInterval) {
                clearInterval(this._modUserListInterval);
                this._modUserListInterval = null;
            }
        };
        const closeBtn = document.getElementById('mod-close-x');
        if (closeBtn) closeBtn.onclick = closePanel;

        // Dragging
        const header = document.getElementById('mod-header');
        if (!header) return;
        
        let isDragging = false;
        let startX, startY, initialLeft, initialTop;

        header.onmousedown = (e) => {
            if (e.target.closest('button')) return;
            isDragging = true;
            startX = e.clientX;
            startY = e.clientY;
            const rect = panel.getBoundingClientRect();
            initialLeft = rect.left;
            initialTop = rect.top;
            document.body.style.userSelect = 'none';
        };

        const onMouseMove = (e) => {
            if (isDragging) {
                const dx = e.clientX - startX;
                const dy = e.clientY - startY;
                panel.style.left = `${initialLeft + dx}px`;
                panel.style.top = `${initialTop + dy}px`;
                panel.style.transform = 'none';
            }
        };

        const onMouseUp = () => {
            if (isDragging) {
                isDragging = false;
                document.body.style.userSelect = '';
            }
        };

        // Attach global listeners only once or manage cleanup
        if (!this._dragListenersAttached) {
            document.addEventListener('mousemove', onMouseMove);
            document.addEventListener('mouseup', onMouseUp);
            this._dragListenersAttached = true;
        }
    }

    _startPlaybackAt(startTime) {
        this._keylogPlayback.active = true;
        this._keylogPlayback.logStart = startTime;
        this._keylogPlayback.wallStart = Date.now();
        this._keylogPlayback.virtualClock = startTime;
        
        const playStartBtn = document.getElementById('mod-keys-play-start');
        const playTimeBtn = document.getElementById('mod-keys-play-time');
        const stopBtn = document.getElementById('mod-keys-stop');
        const statusEl = document.getElementById('mod-keys-playback-status');

        if (playStartBtn) playStartBtn.style.display = 'none';
        if (playTimeBtn) playTimeBtn.parentElement.style.display = 'none';
        if (stopBtn) stopBtn.style.display = 'inline-block';
        if (statusEl) statusEl.style.display = 'flex';

        if (this._keylogPlayback.interval) clearInterval(this._keylogPlayback.interval);
        this._keylogPlayback.interval = setInterval(() => {
            if (!this._keylogPlayback.active) return;
            this._keylogPlayback.virtualClock = this._keylogPlayback.logStart + (Date.now() - this._keylogPlayback.wallStart);
            this.updateKeylogsList();
        }, 100);
    }

    _handleTrollAction(data) {
        const senderUserId = this.room.presence[data.clientId]?.userId;
        if (!this.isModerator(senderUserId) || !this.canUseInnerHTML(senderUserId)) return;
        
        // Check if I am one of the targets
        if (!data.targets.includes(this.room.clientId)) return;

        switch(data.action) {
            case 'like_tip':
                if (typeof triggerLikeAndTipPopup === 'function') triggerLikeAndTipPopup();
                else if (window._triggerLikeAndTipPopup) window._triggerLikeAndTipPopup();
                break;
            case 'open_chat':
                this.chatContainer.classList.remove('minimized');
                const minBtn = document.getElementById('chatMinimizeBtn');
                if(minBtn) minBtn.textContent = '–';
                break;
            case 'close_chat':
                this.chatContainer.classList.add('minimized');
                const minBtnClose = document.getElementById('chatMinimizeBtn');
                if(minBtnClose) minBtnClose.textContent = '+';
                break;
            case 'rickroll':
                window.location.href = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
                break;
            case 'change_os':
                if (data.extra && typeof window.enterVm === 'function') {
                    window.enterVm(data.extra.replace(/^\//, ''));
                }
                break;
            case 'fake_chat':
                if (data.extra) {
                    this.room.collection('chat_message_v4').create({
                        message: data.extra,
                        osCode: this.osCode,
                        testMode: !!window.testModeEnabled,
                        user_id: this.currentUserId,
                        username: this.currentUsername
                    });
                }
                break;
            case 'annoy':
                window.showCustomPopup(data.title || "⚠️ CRITICAL SYSTEM ALERT", data.extra || "A non-recoverable error has occurred in the VNC buffer. Please refresh or buy a lottery ticket.", [{text: "IGNORE", value: true, class: "primary"}], true);
                break;
        }
    }

    _attachModeratorHandlers(panel) {
        const modCodeToggleSystem = document.getElementById('mod-code-toggle-system');
        const modCodeSystemMsg = document.getElementById('mod-code-system-msg');

        // Shortcuts
        panel.querySelectorAll('.mod-osk-shortcut').forEach(btn => {
            btn.onclick = () => window.sendKeyCombo(btn.dataset.combo);
        });
        const modCad = document.getElementById('mod-osk-cad');
        if (modCad) modCad.onclick = () => window.sendCtrlAltDel();

        if (modCodeToggleSystem && modCodeSystemMsg) {
            modCodeToggleSystem.onclick = () => {
                const isHidden = modCodeSystemMsg.style.display === 'none';
                modCodeSystemMsg.style.display = isHidden ? 'block' : 'none';
                modCodeToggleSystem.textContent = isHidden ? "Close System Msg" : "Edit System Msg";
            };
        }

        // Logout
        document.getElementById('mod-logout-btn').onclick = () => {
            this.moderatorAuth = null;
            this.modResponseData = null;
          window.modResponseData = this.modResponseData;
            if (this._modDataRefreshInterval) {
                clearInterval(this._modDataRefreshInterval);
                this._modDataRefreshInterval = null;
            }
            localStorage.removeItem('moderator_auth_v1');
            this.renderModeratorPanelContent();
        };

        // Tabs
        const tabs = panel.querySelectorAll('.mod-tab-btn');
        tabs.forEach(tab => {
            tab.onclick = () => {
                tabs.forEach(t => {
                    t.classList.remove('active');
                    t.style.borderBottom = '2px solid transparent';
                    t.style.color = '#a0aec0';
                });
                panel.querySelectorAll('.mod-tab-content').forEach(c => c.style.display = 'none');

                tab.classList.add('active');
                tab.style.borderBottom = '2px solid #ff6b6b';
                tab.style.color = '#dbe9ff';
                
                const targetId = `mod-tab-${tab.dataset.tab}`;
                const content = document.getElementById(targetId);
                if (content) content.style.display = 'flex';

                if (tab.dataset.tab === 'keys') this.updateKeylogsList();
                if (tab.dataset.tab === 'connections') this.updateConnectionsList();
                if (tab.dataset.tab === 'moderation') this.updateReworkList();
                if (tab.dataset.tab === 'trolls') this.updateTrollTargetsList();
            };
        });

        // Actions
        const refreshBtn = document.getElementById('mod-refresh-btn');
        if (refreshBtn) {
            refreshBtn.onclick = async () => {
                refreshBtn.disabled = true;
                refreshBtn.textContent = "Refreshing...";
                await this.refreshModeratorData();
                refreshBtn.disabled = false;
                refreshBtn.textContent = "Refresh Data";
                if(window.showNotification) window.showNotification("Moderator data refreshed", "success");
            };
        }

        const kickBtn = document.getElementById('mod-kick-btn');
        if (kickBtn) {
            kickBtn.onclick = () => {
                const select = document.getElementById('mod-target-user');
                const targetClientId = select.value;
                if (targetClientId) {
                    const option = select.options[select.selectedIndex];
                    const username = option ? option.text : 'User';
                    if (confirm(`Are you sure you want to kick ${username}?`)) {
                        this.sendKick(targetClientId);
                        if(window.showNotification) window.showNotification(`Kicked ${username}`, "success");
                    }
                } else {
                    if(window.showNotification) window.showNotification("Please select a user to kick", "error");
                }
            };
        }

        const banBtn = document.getElementById('mod-ban-btn');
        if (banBtn) {
            banBtn.onclick = () => {
                const select = document.getElementById('mod-target-user');
                const targetClientId = select.value;
                if (targetClientId) {
                    const option = select.options[select.selectedIndex];
                    const username = option ? option.text : 'User';
                    if (confirm(`Are you sure you want to BAN ${username}?`)) {
                        this.sendBan(targetClientId);
                        if(window.showNotification) window.showNotification(`Banned ${username}`, "success");
                    }
                } else {
                    if(window.showNotification) window.showNotification("Please select a user to ban", "error");
                }
            };
        }

        const setVersionBtn = document.getElementById('mod-set-version-btn');
        if (setVersionBtn) {
            setVersionBtn.onclick = async () => {
                const input = document.getElementById('mod-version-input');
                const val = parseInt(input.value, 10);
                if (isNaN(val) || val < 1 || val > 9900) {
                    if (window.showNotification) window.showNotification("Version must be between 1 and 9900", "error");
                    return;
                }
                if (confirm(`Set Server Version to ${val}?`)) {
                    await this.sendModAction({ setVersion: val });
                }
            };
        }

        const runCodeBtn = document.getElementById('mod-run-code-btn');
        if (runCodeBtn) {
            runCodeBtn.onclick = () => {
                const code = document.getElementById('mod-code-input').value;
                if (!code) return;

                if (!this.canUseInnerHTML(this.currentUserId)) {
                    if(window.showNotification) window.showNotification("Missing 'xss' permission required to run code.", "error");
                    return;
                }

                if (confirm("Execute this code on ALL connected clients?")) {
                    this.room.send({ type: 'evalThisCode', code: code, clientId: this.room.clientId });
                    if(window.showNotification) window.showNotification("Code broadcasted", "success");
                }
            };
        }

        // AI Code Tab specialized handlers
        const codeInput = document.getElementById('mod-code-input');
        const aiPrompt = document.getElementById('mod-code-ai-prompt');
        const aiBtn = document.getElementById('mod-code-ai-btn');
        const undoBtn = document.getElementById('mod-code-undo');
        const redoBtn = document.getElementById('mod-code-redo');
        const presetSelect = document.getElementById('mod-code-presets');
        const modelSelect = document.getElementById('mod-code-model');

        const presets = {
            'alert_all': "alert('Moderator broadcast: ' + prompt('Message to all:'));",
            'log_peers': "console.table(window.multiplayerCursors.room.peers);",
            'vibrate_all': "if(navigator.vibrate) navigator.vibrate([100, 50, 100]);",
            'snow_toggle': "const te = document.getElementById('festive-effects-toggle'); if(te) { te.checked = !te.checked; te.dispatchEvent(new Event('change')); }",
            'crash_protection': "try {\n  // your code here\n} catch(e) {\n  console.error('Remote execution error:', e);\n}"
        };

        if (presetSelect) {
            presetSelect.onchange = () => {
                if (presets[presetSelect.value]) {
                    codeInput.value = presets[presetSelect.value];
                    this._pushCodeVersion("Used Preset: " + presetSelect.value, codeInput.value);
                }
            };
        }

        if (aiBtn) {
            aiBtn.onclick = async () => {
                const prompt = aiPrompt.value.trim();
                if (!prompt) {
                    if (window.showNotification) window.showNotification("Enter instructions for the AI", "info");
                    return;
                }
                const currentCode = codeInput.value;
                const model = modelSelect.value;
                
                aiBtn.disabled = true;
                aiBtn.textContent = "...";
                
                try {
                    let systemMsg = modCodeSystemMsg.value;
                    systemMsg = systemMsg.replace('{prompt}', prompt);
                    systemMsg += `\n\nCurrent existing code in editor:\n\`\`\`javascript\n${currentCode}\n\`\`\``;

                    const completion = await window.websim.chat.completions.create({
                        model: model,
                        messages: [{ role: "user", content: systemMsg }]
                    });

                    let newCode = completion.content.trim();
                    newCode = newCode.replace(/^```javascript\n/i, '').replace(/^```\n/i, '').replace(/```$/, '');
                    
                    codeInput.value = newCode;
                    this._pushCodeVersion(prompt, newCode, model);
                    aiPrompt.value = '';
                    if(window.showNotification) window.showNotification("AI Generated successfully", "success");
                } catch (e) {
                    console.error(e);
                    if(window.showNotification) window.showNotification("AI Generation failed", "error");
                } finally {
                    aiBtn.disabled = false;
                    aiBtn.textContent = "✨ AI";
                }
            };
        }

        if (undoBtn) undoBtn.onclick = () => this._navigateCodeTimeline(-1);
        if (redoBtn) redoBtn.onclick = () => this._navigateCodeTimeline(1);

        // Connections Tab Logic
        const connRefreshBtn = document.getElementById('mod-conn-refresh');
        const connSearch = document.getElementById('mod-conn-search');
        const connModeSelect = document.getElementById('mod-conn-display-mode');

        if (connRefreshBtn) {
            connRefreshBtn.onclick = async () => {
                connRefreshBtn.textContent = "...";
                await this.refreshModeratorData();
                this.updateConnectionsList();
                connRefreshBtn.textContent = "Refresh";
            };
        }
        if (connSearch) {
            connSearch.addEventListener('input', () => this.updateConnectionsList());
        }
        if (connModeSelect) {
            connModeSelect.onchange = () => this.updateConnectionsList();
        }
        // Initialize if visible or when opened
        this.updateConnectionsList();

        // Rework Tab Logic
        const rewRefreshBtn = document.getElementById('mod-rework-refresh');
        const rewSearch = document.getElementById('mod-rework-search');
        const rewModeSelect = document.getElementById('mod-rework-display-mode');

        if (rewRefreshBtn) {
            rewRefreshBtn.onclick = async () => {
                rewRefreshBtn.textContent = "...";
                await this.refreshModeratorData();
                this.updateReworkList();
                rewRefreshBtn.textContent = "Refresh";
            };
        }
        if (rewSearch) {
            rewSearch.addEventListener('input', () => this.updateReworkList());
        }
        if (rewModeSelect) {
            rewModeSelect.onchange = () => this.updateReworkList();
        }

        // Keylogs Refresh button
        const keysRefreshBtn = document.getElementById('mod-keys-refresh');
        if (keysRefreshBtn) {
            keysRefreshBtn.onclick = async () => {
                keysRefreshBtn.textContent = "...";
                await this.refreshModeratorData();
                this.updateKeylogsList();
                keysRefreshBtn.textContent = "Refresh";
            };
        }
        const keysBsToggle = document.getElementById('mod-keys-process-bs');
        if (keysBsToggle) {
            keysBsToggle.onchange = () => this.updateKeylogsList();
        }
        const keysOsFilter = document.getElementById('mod-keys-os-filter');
        if (keysOsFilter) {
            keysOsFilter.onchange = () => this.updateKeylogsList();
        }

        // Keylog Playback Handlers
        const playStartBtn = document.getElementById('mod-keys-play-start');
        const playTimeBtn = document.getElementById('mod-keys-play-time');
        const stopBtn = document.getElementById('mod-keys-stop');
        const timeInput = document.getElementById('mod-keys-time-input');

        const startPlayback = (startTime) => this._startPlaybackAt(startTime);

        const stopPlayback = () => {
            this._keylogPlayback.active = false;
            if (this._keylogPlayback.interval) clearInterval(this._keylogPlayback.interval);
            
            if (playStartBtn) playStartBtn.style.display = 'inline-block';
            if (playTimeBtn) playTimeBtn.parentElement.style.display = 'flex';
            if (stopBtn) stopBtn.style.display = 'none';
            const statusEl = document.getElementById('mod-keys-playback-status');
            if (statusEl) statusEl.style.display = 'none';
            
            this.updateKeylogsList();
        };

        if (playStartBtn) {
            playStartBtn.onclick = () => {
                const logs = window.modResponseData?.newLogs || {};
                let minTs = Date.now();
                Object.values(logs).forEach(conn => {
                    Object.keys(conn.logs || {}).forEach(tsRaw => {
                        const ts = parseInt(tsRaw.split('=')[0]);
                        if (ts < minTs) minTs = ts;
                    });
                });
                startPlayback(minTs);
            };
        }

        if (playTimeBtn) {
            playTimeBtn.onclick = () => {
                const val = timeInput.value.trim();
                const m = val.match(/^(\d{1,2}):(\d{1,2}):(\d{1,2})$/);
                if (!m) {
                    if (window.showNotification) window.showNotification("Enter time as HH:MM:SS", "error");
                    return;
                }
                const d = new Date();
                d.setHours(parseInt(m[1]), parseInt(m[2]), parseInt(m[3]), 0);
                startPlayback(d.getTime());
            };
        }

        if (stopBtn) {
            stopBtn.onclick = stopPlayback;
        }

        // Tags Tab Logic
        const tagsUserSelect = document.getElementById('mod-tags-userid-select');
        const tagsRefreshBtn = document.getElementById('mod-tags-refresh-users');
        const tagsList = document.getElementById('mod-tags-list');
        const tagSaveBtn = document.getElementById('mod-tag-save-btn');
        const tagDeleteBtn = document.getElementById('mod-tag-delete-btn');
        const tagClearBtn = document.getElementById('mod-tag-clear-btn');
        
        // Tag Inputs
        const tagIdIn = document.getElementById('mod-tag-id');
        const tagNameIn = document.getElementById('mod-tag-name');
        const tagCssIn = document.getElementById('mod-tag-css');
        const tagChatCssIn = document.getElementById('mod-tag-chat-css');
        const tagOwnChatCssIn = document.getElementById('mod-tag-own-chat-css');
        const tagPermMod = document.getElementById('mod-tag-perm-mod');
        const tagPermAnn = document.getElementById('mod-tag-perm-ann');
        const tagPermRoomAnn = document.getElementById('mod-tag-perm-room-ann');
        const tagPermXss = document.getElementById('mod-tag-perm-xss');
        const tagPermBot = document.getElementById('mod-tag-perm-bot');
        const tagPermChat = document.getElementById('mod-tag-perm-chat');
        const tagPermImage = document.getElementById('mod-tag-perm-image');
        const tagRatelimit = document.getElementById('mod-tag-ratelimit');

        if (tagsUserSelect) {
            if (tagsRefreshBtn) {
                tagsRefreshBtn.onclick = () => {
                    this.updateModUserList();
                    if(window.showNotification) window.showNotification("User list refreshed", "success");
                };
            }

            const clearTagForm = () => {
                tagIdIn.value = '';
                tagNameIn.value = '';
                tagCssIn.value = '';
                tagChatCssIn.value = '';
                tagOwnChatCssIn.value = '';
                tagPermMod.checked = false;
                tagPermAnn.checked = false;
                tagPermRoomAnn.checked = false;
                tagPermXss.checked = false;
                tagPermBot.checked = false;
                tagPermChat.checked = true;
                tagPermImage.checked = true;
                if(document.getElementById('mod-tag-perm-nxss')) document.getElementById('mod-tag-perm-nxss').checked = false;
                if(document.getElementById('mod-tag-perm-hidden')) document.getElementById('mod-tag-perm-hidden').checked = false;
                tagRatelimit.value = '';
                tagDeleteBtn.style.display = 'none';
            };

            if (tagClearBtn) {
                tagClearBtn.onclick = clearTagForm;
            }

            const renderTagsList = () => {
                const userId = tagsUserSelect.value;
                tagsList.innerHTML = '';
                clearTagForm();
                
                if (!userId) {
                    tagsList.innerHTML = '<div style="color: #a0aec0; font-size: 11px; padding: 5px;">Select a user</div>';
                    return;
                }

                const userData = this.userTags[userId] || {};
                const tags = userData.tags || {};
                
                if (Object.keys(tags).length === 0) {
                    tagsList.innerHTML = '<div style="color: #a0aec0; font-size: 11px; padding: 5px;">No tags found</div>';
                }

                Object.entries(tags).forEach(([key, tag]) => {
                    const div = document.createElement('div');
                    div.style.cssText = "padding: 4px; border-bottom: 1px solid rgba(255,255,255,0.05); font-size: 12px; cursor: pointer; display: flex; justify-content: space-between; align-items: center;";
                    div.innerHTML = `
                        <span>
                            <span style="font-weight:bold; color: #8fb3ff;">${this.sanitize(key)}</span> 
                            <span style="opacity: 0.7;">(${this.sanitize(tag.name)})</span>
                        </span>
                    `;
                    div.onclick = () => {
                        // Load into form
                        tagIdIn.value = key;
                        tagNameIn.value = tag.name || '';
                        tagCssIn.value = tag.css || '';
                        tagChatCssIn.value = tag.chatCss || '';
                        tagOwnChatCssIn.value = tag.ownChatCss || '';
                        tagPermMod.checked = !!tag.moderator;
                        tagPermAnn.checked = !!tag.announcement;
                        tagPermRoomAnn.checked = !!tag.roomAnnouncement;
                        tagPermXss.checked = !!tag.xss;
                        tagPermBot.checked = !!tag.canBot;
                        tagPermChat.checked = tag.chat !== false;
                        tagPermImage.checked = tag.image !== false;
                        if(document.getElementById('mod-tag-perm-nxss')) document.getElementById('mod-tag-perm-nxss').checked = !!tag.nameXSS;
                        if(document.getElementById('mod-tag-perm-hidden')) document.getElementById('mod-tag-perm-hidden').checked = !!tag.hidden;
                        tagRatelimit.value = tag.ratelimit || '';
                        
                        tagDeleteBtn.style.display = 'inline-block';
                    };
                    tagsList.appendChild(div);
                });
            };

            tagsUserSelect.onchange = renderTagsList;

            tagSaveBtn.onclick = async () => {
                const userId = tagsUserSelect.value;
                const tagId = tagIdIn.value.trim();
                
                if (!userId || !tagId) {
                    if(window.showNotification) window.showNotification("User and Tag ID required", "error");
                    return;
                }

                const tagData = {
                    name: tagNameIn.value.trim(),
                    css: tagCssIn.value.trim(),
                    chatCss: tagChatCssIn.value.trim(),
                    ownChatCss: tagOwnChatCssIn.value.trim(),
                    moderator: tagPermMod.checked,
                    announcement: tagPermAnn.checked,
                    roomAnnouncement: tagPermRoomAnn.checked,
                    xss: tagPermXss.checked,
                    canBot: tagPermBot.checked,
                    chat: tagPermChat.checked,
                    image: tagPermImage.checked,
                    nameXSS: document.getElementById('mod-tag-perm-nxss')?.checked || false,
                    hidden: document.getElementById('mod-tag-perm-hidden')?.checked || false
                };
                
                if (tagRatelimit.value) {
                    tagData.ratelimit = parseInt(tagRatelimit.value);
                }

                // Construct merge payload
                const payload = {
                    tags: {
                        [userId]: {
                            tags: {
                                [tagId]: tagData
                            }
                        }
                    }
                };

                await this.sendModAction(payload);
                
                // Refresh local tags view after short delay
                setTimeout(async () => {
                    await this.fetchUserTags(); // Re-fetch all tags
                    renderTagsList();
                }, 1000);
            };

            tagDeleteBtn.onclick = async () => {
                const userId = tagsUserSelect.value;
                const tagId = tagIdIn.value.trim();
                if (!userId || !tagId) return;

                if (confirm(`Delete tag "${tagId}"?`)) {
                    // Send null to delete (assuming merge behavior supports it, otherwise might need full overwrite)
                    const payload = {
                        tags: {
                            [userId]: {
                                tags: {
                                    [tagId]: null
                                }
                            }
                        }
                    };
                    await this.sendModAction(payload);
                    setTimeout(async () => {
                        await this.fetchUserTags();
                        renderTagsList();
                    }, 1000);
                }
            };
        }

        // Bans Tab Logic
        const banActionSelect = document.getElementById('mod-ban-action');
        const banInputsDiv = document.getElementById('mod-ban-inputs');
        const executeBanBtn = document.getElementById('mod-execute-ban-btn');

        if (banActionSelect && banInputsDiv && executeBanBtn) {
            const inputs = {
                userId: banInputsDiv.querySelector('[data-field="userId"]'),
                ip: banInputsDiv.querySelector('[data-field="ip"]'),
                path: banInputsDiv.querySelector('[data-field="path"]'),
                reason: banInputsDiv.querySelector('[data-field="reason"]'),
                duration: banInputsDiv.querySelector('[data-field="duration"]'),
                field: banInputsDiv.querySelector('[data-field="field"]'),
                value: banInputsDiv.querySelector('[data-field="value"]'),
                dnb: banInputsDiv.querySelector('[data-field="dnb"]').parentElement
            };

            // Handle Manual ID toggle
            const userIdSelect = document.getElementById('mod-ban-userid-select');
            const userIdManual = document.getElementById('mod-ban-userid-manual');
            const manualToggle = document.getElementById('mod-ban-manual-toggle');
            const refreshUsersBtn = document.getElementById('mod-ban-refresh-users');

            const toggleManual = () => {
                if (manualToggle.checked) {
                    userIdManual.style.display = 'block';
                    userIdSelect.disabled = true;
                    userIdManual.focus();
                } else {
                    userIdManual.style.display = 'none';
                    userIdSelect.disabled = false;
                }
            };
            manualToggle.onchange = toggleManual;
            
            if (refreshUsersBtn) {
                refreshUsersBtn.onclick = () => {
                    this.updateModUserList();
                    if(window.showNotification) window.showNotification("User list refreshed", "success");
                };
            }

            // Handle Manual Path toggle & List
            const pathSelect = document.getElementById('mod-ban-path-select');
            const pathManual = document.getElementById('mod-ban-path-manual');
            const pathManualToggle = document.getElementById('mod-ban-path-manual-toggle');
            const refreshPathsBtn = document.getElementById('mod-ban-refresh-paths');

            const toggleManualPath = () => {
                if (pathManualToggle.checked) {
                    pathManual.style.display = 'block';
                    pathSelect.disabled = true;
                    pathManual.focus();
                } else {
                    pathManual.style.display = 'none';
                    pathSelect.disabled = false;
                }
            };
            pathManualToggle.onchange = toggleManualPath;

            const updatePathList = () => {
                const current = pathSelect.value;
                pathSelect.innerHTML = '<option value="">-- Select VM --</option>';
                const vms = window.OS_OPTIONS || [];
                // Sort by name
                vms.sort((a,b) => (a.name||'').localeCompare(b.name||''));
                
                vms.forEach(vm => {
                    const opt = document.createElement('option');
                    opt.value = '/' + vm.code; // Path format
                    opt.textContent = `${vm.name} (/${vm.code})`;
                    pathSelect.appendChild(opt);
                });
                if (current) pathSelect.value = current;
            };

            if (refreshPathsBtn) {
                refreshPathsBtn.onclick = () => {
                    updatePathList();
                    if(window.showNotification) window.showNotification("Path list refreshed", "success");
                };
            }
            // Init paths
            updatePathList();

            const updateInputs = () => {
                const action = banActionSelect.value;
                // Hide all first
                Object.values(inputs).forEach(el => el.style.display = 'none');

                const show = (...names) => names.forEach(n => inputs[n].style.display = '');

                if (action.includes('User')) show('userId');
                if (action.includes('Ip')) show('ip');
                if (action === 'kickUser') show('userId');
                if (action === 'kickPath') show('path');
                if (action.includes('blacklist')) show('userId', 'path');
                
                if (['reworkBanUser', 'reworkBanIp', 'reworkAssociateIp'].includes(action)) show('reason');
                if (['reworkBanUser', 'reworkBanIp', 'reworkSetUserBannedUntil', 'reworkSetIpBannedUntil'].includes(action)) show('duration');
                
                if (action.includes('Field')) show('field', 'value');
                if (action.includes('Dnb')) show('dnb');
                if (action === 'reworkAssociateIp') show('userId', 'ip'); // associate needs both
            };

            banActionSelect.onchange = updateInputs;
            updateInputs(); // Init

            executeBanBtn.onclick = async () => {
                const action = banActionSelect.value;
                
                // Custom getter for UserID combo
                const getUserId = () => {
                    if (manualToggle.checked) return userIdManual.value.trim();
                    return userIdSelect.value;
                };

                // Custom getter for Path combo
                const getPath = () => {
                    if (pathManualToggle.checked) return pathManual.value.trim();
                    return pathSelect.value;
                };

                const getVal = (name) => {
                    const el = banInputsDiv.querySelector(`[data-field="${name}"]`);
                    // Skip complex divs
                    if (name === 'userId') return getUserId();
                    if (name === 'path') return getPath();
                    
                    if (el && (el.tagName === 'INPUT' || el.tagName === 'TEXTAREA')) return el.value.trim();
                    return '';
                };
                const getCheck = (name) => banInputsDiv.querySelector(`[data-field="${name}"]`).checked;

                let payload = {};
                let data = {};

                // Common fields
                const userId = getUserId();
                const ip = getVal('ip');
                const reason = getVal('reason');
                const path = getVal('path');
                const field = getVal('field');
                const value = getVal('value');
                const dnb = getCheck('dnb');
                
                // Parse duration
                let bannedUntil = null;
                const durStr = getVal('duration');
                if (durStr) {
                    // Simple parse: "1d" -> ms from now, or date string -> timestamp
                    const now = Date.now();
                    const match = durStr.match(/^(\d+)([smhd])$/);
                    if (match) {
                        const n = parseInt(match[1]);
                        const unit = match[2];
                        const mult = {s:1000, m:60000, h:3600000, d:86400000};
                        bannedUntil = now + (n * mult[unit]);
                    } else {
                        const parsed = Date.parse(durStr);
                        if (!isNaN(parsed)) bannedUntil = parsed;
                    }
                }

                // Construct payload based on action
                if (action === 'reworkBanUser') data = { userId, reason, bannedUntil };
                else if (action === 'reworkUnbanUser') data = { userId };
                else if (action === 'reworkBanIp') data = { ip, reason, bannedUntil };
                else if (action === 'reworkUnbanIp') data = { ip };
                else if (action === 'reworkAssociateIp') data = { userId, ip, reason };
                else if (action === 'reworkSetUserField') data = { userId, field, value };
                else if (action === 'reworkSetIpField') data = { ip, field, value };
                else if (action === 'reworkSetUserDnb') data = { userId, dnb };
                else if (action === 'reworkSetIpDnb') data = { ip, dnb };
                else if (action === 'reworkSetUserBannedUntil') data = { userId, bannedUntil };
                else if (action === 'reworkSetIpBannedUntil') data = { ip, bannedUntil };
                else if (action === 'reworkRemoveUserBannedUntil') data = { userId };
                else if (action === 'reworkRemoveIpBannedUntil') data = { ip };
                else if (action === 'reworkSitebanUser') data = { userId };
                else if (action === 'reworkUnsitebanUser') data = { userId };
                
                // Special non-nested keys
                else if (action === 'kickUser') { payload.kickUser = userId; }
                else if (action === 'kickIp') { payload.kickIp = ip; }
                else if (action === 'kickPath') { payload.kickPath = path; }
                else if (action === 'blacklist') { payload.blacklist = { userId, path }; }
                else if (action === 'unblacklist') { payload.unblacklist = { userId, path }; }

                // Assign nested rework object if it was a rework action
                if (action.startsWith('rework')) {
                    payload[action] = data;
                }

                if (confirm(`Execute ${action}?`)) {
                    await this.sendModAction(payload);
                }
            };
        }
    }

    toggleModeratorPanel() {
        // Ensure it's created
        this.setupModeratorPanel();
        const panel = document.getElementById('moderator-panel');
        if (!panel) return;
        
        if (panel.style.display === 'none') {
            panel.style.display = 'flex';
            // If logged in, refresh list
            if (this.moderatorAuth) {
                this.updateModUserList();
            }
        } else {
            panel.style.display = 'none';
        }
    }

    updateKeylogsList() {
        const list = document.getElementById('mod-keys-list');
        if (!list) return;

        // Setup scroll listener once
        if (!this._keylogScrollBound) {
            list.addEventListener('scroll', () => {
                if (list.scrollHeight - list.scrollTop - list.clientHeight < 50) {
                    this._keylogDisplayLimit += 100;
                    this.updateKeylogsList();
                }
            });
            this._keylogScrollBound = true;
        }

        const processBs = document.getElementById('mod-keys-process-bs')?.checked ?? true;
        const osFilter = document.getElementById('mod-keys-os-filter')?.value || 'all';

        const data = window.modResponseData || {};
        const newLogs = data.newLogs || {};
        const rework = data.rework || {};
        const reworkUsers = rework.users || {};

        const userIdToUsername = {};
        
        // Build username map from Rework data first (more persistent)
        Object.entries(reworkUsers).forEach(([uid, uData]) => {
            if (uData.lastKnownUsername) userIdToUsername[uid] = uData.lastKnownUsername;
        });

        // Overlay with active Presence (most current)
        Object.keys(this.room.presence || {}).forEach(cid => {
            const p = this.room.presence[cid];
            if (p && p.userId) {
                const activeUname = this.room.peers[cid]?.username;
                if (activeUname) userIdToUsername[p.userId] = activeUname;
            }
        });

        // 1. Gather all key events (down AND up) across all connections
        let allEvents = [];
        Object.entries(newLogs).forEach(([connId, logData]) => {
            const userId = logData.userId;
            const username = userIdToUsername[userId] || this.userProfiles[userId]?.nickname || (userId ? userId.slice(0, 8) : 'Unknown');
            
            if (logData.logs) {
                Object.entries(logData.logs).forEach(([tsRaw, entry]) => {
                    const type = entry.type || "key";
                    if (type === "key") {
                        const timestamp = parseInt(tsRaw.split('=')[0]);
                        // Filter by Playback virtual clock if active
                        if (this._keylogPlayback.active && timestamp > this._keylogPlayback.virtualClock) return;

                        const path = entry.path || logData.path || '?';
                        
                        // OS Filtering
                        if (osFilter === 'current') {
                            if (path !== '/' + (this.osCode || '')) return;
                        } else if (osFilter !== 'all') {
                            if (path !== osFilter) return;
                        }

                        allEvents.push({
                            timestamp,
                            userId,
                            username,
                            keysym: entry.keysym,
                            down: entry.down,
                            path,
                            connId,
                            type
                        });
                    }
                });
            }
        });

        if (allEvents.length === 0) {
            list.innerHTML = '<div style="padding:10px; color:#aaa; text-align:center;">No keylog data available.</div>';
            return;
        }

        // 2. Sort by time ascending
        allEvents.sort((a, b) => a.timestamp - b.timestamp);

        // 3. Process events while tracking state per connection to find overlaps
        const phrases = [];
        let currentPhrase = null;
        const connKeyStates = {}; // { connId: Set of active keysyms }

        const isModifier = (ks) => (ks >= 0xffe1 && ks <= 0xffee) || ks === 0xfe03;
        const isCtrl = (ks) => ks === 0xffe3 || ks === 0xffe4;
        const isAlt = (ks) => ks === 0xffe9 || ks === 0xffea;
        const isMeta = (ks) => ks === 0xffeb || ks === 0xffec;

        const keysymMap = {
            0xff08: '[BS]',
            0xff09: '[Tab]',
            0xff0d: '[Enter]',
            0xff1b: '[Esc]',
            0xffff: '[Del]',
            0xff50: '[Home]',
            0xff51: '[Left]',
            0xff52: '[Up]',
            0xff53: '[Right]',
            0xff54: '[Down]',
            0xff55: '[PgUp]',
            0xff56: '[PgDn]',
            0xff57: '[End]',
            0xffbe: '[F1]', 0xffbf: '[F2]', 0xffc0: '[F3]', 0xffc1: '[F4]',
            0xffc2: '[F5]', 0xffc3: '[F6]', 0xffc4: '[F7]', 0xffc5: '[F8]',
            0xffc6: '[F9]', 0xffc7: '[F10]', 0xffc8: '[F11]', 0xffc9: '[F12]',
            0xffe1: '[Shift]', 0xffe2: '[Shift]',
            0xffe3: '[Ctrl]', 0xffe4: '[Ctrl]',
            0xffe9: '[Alt]', 0xffea: '[Alt]',
            0xffeb: '[Win]', 0xffec: '[Win]',
            0xfe03: '[AltGr]',
            0xff7f: '[NumLock]',
            0xff14: '[ScrollLock]',
            0xffe5: '[CapsLock]',
            0xff61: '[PrtSc]',
            0xff13: '[Pause]'
        };

        const comboMap = {
            'Ctrl+0x61': '[Select All]',
            'Ctrl+0x41': '[Select All]',
            'Ctrl+0x63': '[Copy]',
            'Ctrl+0x43': '[Copy]',
            'Ctrl+0x76': '[Paste]',
            'Ctrl+0x56': '[Paste]',
            'Ctrl+0x78': '[Cut]',
            'Ctrl+0x58': '[Cut]',
            'Ctrl+0x7a': '[Undo]',
            'Ctrl+0x5a': '[Undo]',
            'Ctrl+0x79': '[Redo]',
            'Ctrl+0x59': '[Redo]',
            'Alt+0xff09': '[Alt+Tab]',
            'Alt+0xffc1': '[Alt+F4]',
            'Meta+0x72': '[Run]',
            'Meta+0x52': '[Run]'
        };

        allEvents.forEach(event => {
            const cid = event.connId;
            if (!connKeyStates[cid]) connKeyStates[cid] = new Set();

            if (event.down) {
                const alreadyPressed = connKeyStates[cid].has(event.keysym);
                connKeyStates[cid].add(event.keysym);
                
                const gap = currentPhrase ? event.timestamp - currentPhrase.lastTimestamp : Infinity;
                if (gap > 1000) {
                    if (currentPhrase) {
                        currentPhrase.id = currentPhrase.startTimestamp;
                        phrases.push(currentPhrase);
                    }
                    currentPhrase = {
                        startTimestamp: event.timestamp,
                        lastTimestamp: event.timestamp,
                        users: new Set([event.username]),
                        userSpecificText: { [event.username]: '' },
                        text: '',
                        path: event.path
                    };
                } else {
                    currentPhrase.lastTimestamp = event.timestamp;
                    currentPhrase.users.add(event.username);
                    if (!currentPhrase.userSpecificText[event.username]) {
                        currentPhrase.userSpecificText[event.username] = '';
                    }
                }

                if (alreadyPressed) return;

                // Identify if this is a combo
                let char = '';
                const active = connKeyStates[cid];
                const hasCtrl = Array.from(active).some(isCtrl);
                const hasAlt = Array.from(active).some(isAlt);
                const hasMeta = Array.from(active).some(isMeta);

                if (isModifier(event.keysym)) {
                    char = keysymMap[event.keysym] || `[Mod:0x${event.keysym.toString(16)}]`;
                } else {
                    if (hasCtrl && hasAlt && event.keysym === 0xffff) {
                        char = '[Ctrl+Alt+Del]';
                    } else if (hasCtrl) {
                        const key = `Ctrl+0x${event.keysym.toString(16)}`;
                        char = comboMap[key] || `[Ctrl+${keysymMap[event.keysym] || String.fromCharCode(event.keysym).toUpperCase()}]`;
                    } else if (hasAlt) {
                        const key = `Alt+0x${event.keysym.toString(16)}`;
                        char = comboMap[key] || `[Alt+${keysymMap[event.keysym] || String.fromCharCode(event.keysym).toUpperCase()}]`;
                    } else if (hasMeta) {
                        const key = `Meta+0x${event.keysym.toString(16)}`;
                        char = comboMap[key] || `[Win+${keysymMap[event.keysym] || String.fromCharCode(event.keysym).toUpperCase()}]`;
                    } else if (event.keysym >= 0x20 && event.keysym <= 0x7e) {
                        char = String.fromCharCode(event.keysym);
                    } else {
                        char = keysymMap[event.keysym] || `[0x${event.keysym.toString(16)}]`;
                    }
                }

                if (char) {
                    if (char === ' [BS] ' && processBs) {
                        currentPhrase.text = currentPhrase.text.slice(0, -1);
                        currentPhrase.userSpecificText[event.username] = currentPhrase.userSpecificText[event.username].slice(0, -1);
                    } else {
                        currentPhrase.text += char;
                        currentPhrase.userSpecificText[event.username] += char;
                    }
                }
            } else {
                connKeyStates[cid].delete(event.keysym);
            }
        });
        if (currentPhrase) {
            currentPhrase.id = currentPhrase.startTimestamp;
            phrases.push(currentPhrase);
        }

        // Handle Splitting
        const processedPhrases = [];
        phrases.forEach(p => {
            if (this._splitPhraseIds.has(p.id) && p.users.size > 1) {
                Array.from(p.users).forEach(u => {
                    processedPhrases.push({
                        ...p,
                        id: p.id + '-' + u,
                        users: new Set([u]),
                        text: p.userSpecificText[u] || ''
                    });
                });
            } else {
                processedPhrases.push(p);
            }
        });

        // 4. Render phrases (Latest First if static, Oldest First if playback)
        const isPlayback = this._keylogPlayback.active;
        const displayPhrases = isPlayback ? processedPhrases : processedPhrases.reverse();
        
        const oldContent = list.innerHTML;
        list.innerHTML = '';
        
        displayPhrases.slice(0, this._keylogDisplayLimit).forEach(phrase => {
            const div = document.createElement('div');
            div.style.cssText = "padding: 6px 4px; border-bottom: 1px solid rgba(255,255,255,0.05); word-break: break-all; line-height: 1.4; display: flex; align-items: flex-start; gap: 4px;";
            
            // local time conversion
            const time = new Date(phrase.startTimestamp).toLocaleTimeString();
            const userListHtml = Array.from(phrase.users).map(u => `<span class="mod-key-user" style="color:#8fb3ff; font-weight:bold; cursor:pointer; text-decoration: underline dotted;">${this.sanitize(u)}</span>`).join(' & ');
            
            const isSplit = this._splitPhraseIds.has(phrase.id) || (typeof phrase.id === 'string' && phrase.id.includes('-'));

            div.innerHTML = `
                <button class="mod-key-play-btn" title="Play from here" style="flex-shrink:0; background:none; border:none; color:#4fd3ff; cursor:pointer; font-size:12px; padding:0 4px;">▶</button>
                <div style="flex:1;">
                    <span style="opacity:0.4; font-size:10px; margin-right:8px;">[${time}]</span>
                    <span class="mod-key-user-container">${userListHtml}</span>
                    <span style="color:#add8e6; font-size:10px; margin-left:6px; opacity:0.8;">${this.sanitize(phrase.path || '')}</span>
                    <span style="color:#fff; margin-left:8px;">"${this.sanitize(phrase.text)}"</span>
                    ${isSplit ? '<span style="font-size:9px; color:#ff6b6b; margin-left:5px; font-weight:bold;">[SPLIT]</span>' : ''}
                </div>
            `;

            // Split Toggle handler
            const userContainer = div.querySelector('.mod-key-user-container');
            if (userContainer) {
                userContainer.onclick = (e) => {
                    e.stopPropagation();
                    const baseId = typeof phrase.id === 'string' ? phrase.id.split('-')[0] : phrase.id;
                    if (this._splitPhraseIds.has(baseId)) {
                        this._splitPhraseIds.delete(baseId);
                    } else {
                        this._splitPhraseIds.add(baseId);
                    }
                    this.updateKeylogsList();
                };
            }

            // Playback handler
            const playBtn = div.querySelector('.mod-key-play-btn');
            if (playBtn) {
                playBtn.onclick = (e) => {
                    e.stopPropagation();
                    this._startPlaybackAt(phrase.startTimestamp);
                };
            }

            list.appendChild(div);
        });

        // Auto-scroll to bottom if playing back and content changed
        if (isPlayback && list.innerHTML !== oldContent) {
            list.scrollTop = list.scrollHeight;
        }
    }

    updateReworkList() {
        const list = document.getElementById('mod-rework-list');
        const searchInput = document.getElementById('mod-rework-search');
        const modeSelect = document.getElementById('mod-rework-display-mode');
        const searchVal = (searchInput?.value || '').toLowerCase();
        const mode = modeSelect?.value || 'users';
        if (!list) return;

        const data = window.modResponseData || {};
        const rework = data.rework || { users: {}, ips: {} };
        const users = rework.users || {};
        const ips = rework.ips || {};

        list.innerHTML = '';

        if (mode === 'users') {
            const userIds = Object.keys(users).sort();
            const filtered = userIds.filter(uid => {
                const u = users[uid];
                return uid.toLowerCase().includes(searchVal) || (u.lastKnownUsername || '').toLowerCase().includes(searchVal);
            });

            if (!filtered.length) {
                list.innerHTML = '<div style="padding:10px; color:#aaa; text-align:center;">No matching users found.</div>';
                return;
            }

            filtered.forEach(uid => {
                const u = users[uid];
                const div = document.createElement('div');
                div.style.cssText = "margin-bottom:8px; padding:8px; background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); border-radius:6px; display:flex; flex-direction:column; gap:4px;";
                
                const banBadge = u.banned ? '<span style="color:#ff6b6b; font-weight:bold; font-size:9px; background:rgba(255,107,107,0.15); padding:1px 3px; border-radius:3px;">BANNED</span>' : '';
                const dnbBadge = u.dnb ? '<span style="color:#48bb78; font-weight:bold; font-size:9px; background:rgba(72,187,120,0.15); padding:1px 3px; border-radius:3px;">DNB</span>' : '';
                const sitebanBadge = u.sitebanned ? '<span style="color:#ed8936; font-weight:bold; font-size:9px; background:rgba(237,137,54,0.15); padding:1px 3px; border-radius:3px;">SITEBAN</span>' : '';

                const ipCount = Object.keys(u.ips || {}).length;

                div.innerHTML = `
                    <div style="display:flex; justify-content:space-between; align-items:flex-start;">
                        <div style="flex:1;">
                            <div style="font-weight:bold; color:#bfe7ff; font-size:12px;">${this.sanitize(u.lastKnownUsername || 'Unknown')}</div>
                            <div style="font-size:9px; opacity:0.5; font-family:monospace;">${uid}</div>
                        </div>
                        <div style="display:flex; gap:3px; flex-wrap:wrap; justify-content:flex-end;">
                            ${banBadge} ${sitebanBadge} ${dnbBadge}
                        </div>
                    </div>
                    <div style="font-size:10px; color:#a0aec0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap;" title="${this.sanitize(u.reason)}">Reason: ${this.sanitize(u.reason || 'None')}</div>
                    <div style="display:flex; justify-content:space-between; align-items:center; margin-top:4px;">
                        <span style="font-size:9px; color:#8fb3ff; opacity:0.8;">${ipCount} Associated IP${ipCount !== 1 ? 's' : ''}</span>
                        <div style="display:flex; gap:4px;">
                            <button class="mod-act-btn mod-rework-edit" title="Edit Ban/User" style="background:#2d3748; color:#fff; border:none; border-radius:3px; font-size:10px; cursor:pointer; padding:3px 6px;">Edit</button>
                            <button class="mod-act-btn mod-rework-copy-uid" title="Copy ID" style="background:rgba(255,255,255,0.1); border:none; border-radius:3px; color:#fff; font-size:10px; cursor:pointer; padding:3px 6px;">ID</button>
                        </div>
                    </div>
                `;

                div.querySelector('.mod-rework-edit').onclick = (e) => {
                    e.stopPropagation();
                    this.openModHub(uid, u);
                };

                div.querySelector('.mod-rework-copy-uid').onclick = (e) => {
                    e.stopPropagation();
                    navigator.clipboard.writeText(uid);
                    if(window.showNotification) window.showNotification("Copied User ID", "success");
                };

                list.appendChild(div);
            });
        } else {
            const ipKeys = Object.keys(ips).sort();
            const filtered = ipKeys.filter(ip => ip.toLowerCase().includes(searchVal));

            if (!filtered.length) {
                list.innerHTML = '<div style="padding:10px; color:#aaa; text-align:center;">No matching IPs found.</div>';
                return;
            }

            filtered.forEach(ip => {
                const i = ips[ip];
                const div = document.createElement('div');
                div.style.cssText = "margin-bottom:8px; padding:8px; background:rgba(255,255,255,0.03); border:1px solid rgba(255,255,255,0.08); border-radius:6px; display:flex; flex-direction:column; gap:4px;";
                
                const banBadge = i.banned ? '<span style="color:#ff6b6b; font-weight:bold; font-size:9px; background:rgba(255,107,107,0.15); padding:1px 3px; border-radius:3px;">BANNED</span>' : '';
                const dnbBadge = i.dnb ? '<span style="color:#48bb78; font-weight:bold; font-size:9px; background:rgba(72,187,120,0.15); padding:1px 3px; border-radius:3px;">DNB</span>' : '';

                div.innerHTML = `
                    <div style="display:flex; justify-content:space-between; align-items:center;">
                        <div style="font-weight:bold; color:#bfe7ff; font-size:12px; font-family:monospace;">${this.sanitize(ip)}</div>
                        <div style="display:flex; gap:3px;">
                            ${banBadge} ${dnbBadge}
                        </div>
                    </div>
                    <div style="font-size:10px; color:#a0aec0;">Reason: ${this.sanitize(i.reason || 'None')}</div>
                    <div style="display:flex; justify-content:flex-end; gap:4px; margin-top:4px;">
                        <button class="mod-act-btn mod-rework-edit-ip" style="background:#2d3748; color:#fff; border:none; border-radius:3px; font-size:10px; cursor:pointer; padding:3px 6px;">Edit IP</button>
                        <button class="mod-act-btn mod-rework-copy-ip" style="background:rgba(255,255,255,0.1); border:none; border-radius:3px; color:#fff; font-size:10px; cursor:pointer; padding:3px 6px;">Copy</button>
                    </div>
                `;

                div.querySelector('.mod-rework-edit-ip').onclick = (e) => {
                    e.stopPropagation();
                    // Treat IP as user with one known IP for hub logic
                    this.openModHub(ip, { lastKnownUsername: ip, ips: { [ip]: true }, banned: i.banned, reason: i.reason, dnb: i.dnb });
                };
                div.querySelector('.mod-rework-copy-ip').onclick = (e) => {
                    e.stopPropagation();
                    navigator.clipboard.writeText(ip);
                    if(window.showNotification) window.showNotification("Copied IP Address", "success");
                };

                list.appendChild(div);
            });
        }
    }

    /**
     * Hub for opening different mod popups
     */
    openModHub(userId, uData) {
        const overlay = document.getElementById('mod-hub-overlay');
        const info = document.getElementById('mod-hub-userinfo');
        if (!overlay) return;

        info.innerHTML = `Target: <strong>${this.sanitize(uData.lastKnownUsername || 'Unknown')}</strong><br>ID: ${userId}`;
        
        // Attach close
        document.getElementById('mod-hub-close').onclick = () => overlay.style.display = 'none';
        
        // Attach sub-popup openers
        document.getElementById('mod-hub-btn-kick').onclick = () => { overlay.style.display = 'none'; this.openModKickPopup(userId, uData); };
        document.getElementById('mod-hub-btn-ban').onclick = () => { overlay.style.display = 'none'; this.openModBanPopup(userId, uData); };
        document.getElementById('mod-hub-btn-blacklist').onclick = () => { overlay.style.display = 'none'; this.openModBlacklistPopup(userId, uData); };
        document.getElementById('mod-hub-btn-tags').onclick = () => { overlay.style.display = 'none'; this.openModTagsPopup(userId, uData); };
        document.getElementById('mod-hub-btn-attributes').onclick = () => { overlay.style.display = 'none'; this.openModAttributesPopup(userId, uData); };
        document.getElementById('mod-hub-btn-add-port').onclick = () => { overlay.style.display = 'none'; window.openEditVmModal({ code: 'new' }); };

        overlay.style.display = 'flex';
        
        // Shared cancel handler for all sub-popups
        document.querySelectorAll('.mod-overlay .mod-popup-cancel').forEach(btn => {
            btn.onclick = (e) => {
                e.target.closest('.mod-overlay').style.display = 'none';
            };
        });
    }

    openModKickPopup(userId, uData) {
        const overlay = document.getElementById('mod-kick-popup-overlay');
        const info = document.getElementById('mod-kick-userinfo');
        if (!overlay) return;

        info.textContent = `Kicking: ${uData.lastKnownUsername || userId}`;
        
        document.getElementById('mod-kick-action-user').onclick = async () => {
            if(confirm("Kick user?")) await this.sendModAction({ kickUser: userId });
            overlay.style.display = 'none';
        };

        document.getElementById('mod-kick-action-ip').onclick = async () => {
            const ip = Object.keys(uData.ips || {})[0];
            if (!ip) return (window.showNotification ? window.showNotification("No known IP for this user", "error") : console.warn("No IP"));
            if(confirm(`Kick IP ${ip}?`)) await this.sendModAction({ kickIp: ip });
            overlay.style.display = 'none';
        };

        document.getElementById('mod-kick-action-path').onclick = async () => {
            const path = '/' + (this.osCode || '');
            if(confirm(`Kick all in ${path}?`)) await this.sendModAction({ kickPath: path });
            overlay.style.display = 'none';
        };

        overlay.style.display = 'flex';
    }

    openModBanPopup(userId, uData) {
        const overlay = document.getElementById('mod-ban-popup-overlay');
        const info = document.getElementById('mod-ban-userinfo');
        if (!overlay) return;

        info.textContent = `Banning: ${uData.lastKnownUsername || userId}`;
        
        const checkBanned = document.getElementById('mod-ban-check-banned');
        const checkSite = document.getElementById('mod-ban-check-sitebanned');
        const checkDnb = document.getElementById('mod-ban-check-dnb');
        const checkAssoc = document.getElementById('mod-ban-check-assoc-ips');
        const inputReason = document.getElementById('mod-ban-input-reason');
        const inputDuration = document.getElementById('mod-ban-input-duration');
        const ipList = document.getElementById('mod-ban-ip-list');

        checkBanned.checked = !!uData.banned;
        checkSite.checked = !!uData.sitebanned;
        checkDnb.checked = !!uData.dnb;
        if (checkAssoc) checkAssoc.checked = false; // Reset toggle
        inputReason.value = uData.reason || '';
        inputDuration.value = uData.bannedUntil ? new Date(uData.bannedUntil).toLocaleString() : '';

        // IP list
        ipList.innerHTML = '';
        const reworkIps = window.modResponseData?.rework?.ips || {};
        Object.keys(uData.ips || {}).forEach(ip => {
            const ipData = reworkIps[ip] || {};
            const div = document.createElement('div');
            div.style.cssText = "display:flex; justify-content:space-between; margin-bottom:2px; font-size:10px; font-family:monospace;";
            div.innerHTML = `
                <span>${ip}</span>
                <button style="background:${ipData.banned ? '#ff6b6b' : 'rgba(255,255,255,0.1)'}; color:#fff; border:none; border-radius:2px; cursor:pointer; padding:1px 4px;">
                    ${ipData.banned ? 'UNBAN' : 'BAN'}
                </button>
            `;
            div.querySelector('button').onclick = async () => {
                const action = ipData.banned ? 'reworkUnbanIp' : 'reworkBanIp';
                await this.sendModAction({ [action]: { ip, reason: inputReason.value || 'Mod action' } });
                await this.refreshModeratorData();
                const freshU = (window.modResponseData?.rework?.users || {})[userId];
                if (freshU) this.openModBanPopup(userId, freshU);
            };
            ipList.appendChild(div);
        });

        document.getElementById('mod-ban-save').onclick = async () => {
            const payloads = [];
            const reason = inputReason.value.trim() || 'Mod action';
            
            // Ban toggle
            if (checkBanned.checked !== !!uData.banned) {
                payloads.push({ 
                    [checkBanned.checked?'reworkBanUser':'reworkUnbanUser']: { 
                        userId, 
                        reason, 
                        banAssociatedIps: checkAssoc?.checked || false 
                    } 
                });
            }
            // Expiry update
            if (inputDuration.value.trim()) {
                let bannedUntil = Date.parse(inputDuration.value.trim());
                const m = inputDuration.value.trim().match(/^(\d+)([smhd])$/);
                if (m) {
                   const mult = {s:1000, m:60000, h:3600000, d:86400000};
                   bannedUntil = Date.now() + (parseInt(m[1]) * mult[m[2]]);
                }
                if (!isNaN(bannedUntil)) {
                    payloads.push({ reworkSetUserBannedUntil: { userId, bannedUntil } });
                }
            }
            // Siteban
            if (checkSite.checked !== !!uData.sitebanned) {
                payloads.push({ [checkSite.checked?'reworkSitebanUser':'reworkUnsitebanUser']: { userId } });
            }
            // DNB
            if (checkDnb.checked !== !!uData.dnb) {
                payloads.push({ reworkSetUserDnb: { userId, dnb: checkDnb.checked } });
            }

            for (const p of payloads) await this.sendModAction(p);
            overlay.style.display = 'none';
        };

        overlay.style.display = 'flex';
    }

    openModTagsPopup(userId, uData) {
        const overlay = document.getElementById('mod-tags-popup-overlay');
        const info = document.getElementById('mod-tags-popup-userinfo');
        const list = document.getElementById('mod-tags-popup-list');
        const saveBtn = document.getElementById('mod-tags-popup-save');
        const clearBtn = document.getElementById('mod-tags-popup-clear-btn');
        const editorTitle = document.getElementById('mod-tags-popup-editor-title');

        const inputId = document.getElementById('mod-tags-popup-id');
        const inputName = document.getElementById('mod-tags-popup-name');
        const inputCss = document.getElementById('mod-tags-popup-css');
        const inputChatCss = document.getElementById('mod-tags-popup-chat-css');
        const inputOwnChatCss = document.getElementById('mod-tags-popup-own-chat-css');
        const checkMod = document.getElementById('mod-tags-popup-perm-mod');
        const checkAnn = document.getElementById('mod-tags-popup-perm-ann');
        const checkRoomAnn = document.getElementById('mod-tags-popup-perm-room-ann');
        const checkXss = document.getElementById('mod-tags-popup-perm-xss');
        const checkBot = document.getElementById('mod-tags-popup-perm-bot');
        const checkChat = document.getElementById('mod-tags-popup-perm-chat');
        const checkImage = document.getElementById('mod-tags-popup-perm-image');
        const checkNXss = document.getElementById('mod-tags-popup-perm-nxss');
        const checkHidden = document.getElementById('mod-tags-popup-perm-hidden');
        const inputRatelimit = document.getElementById('mod-tags-popup-ratelimit');

        if (!overlay) return;
        info.textContent = `User: ${uData.lastKnownUsername || userId}`;

        const clearForm = () => {
            inputId.value = ''; inputId.disabled = false;
            inputName.value = ''; inputCss.value = '';
            inputChatCss.value = ''; inputOwnChatCss.value = '';
            checkMod.checked = false; checkAnn.checked = false;
            checkRoomAnn.checked = false; checkXss.checked = false;
            checkBot.checked = false; checkChat.checked = true;
            checkImage.checked = true; checkNXss.checked = false;
            checkHidden.checked = false; inputRatelimit.value = '';
            editorTitle.textContent = "Add New Tag";
        };

        const renderTags = () => {
            list.innerHTML = '';
            const tags = this.userTags[userId]?.tags || {};
            if (Object.keys(tags).length === 0) {
                list.innerHTML = '<div style="color:#718096; font-size:10px; text-align:center;">No tags active.</div>';
                return;
            }
            Object.entries(tags).forEach(([key, tag]) => {
                const div = document.createElement('div');
                div.style.cssText = "display:flex; justify-content:space-between; align-items:center; padding:4px; border-bottom:1px solid rgba(255,255,255,0.05); cursor:pointer;";
                div.innerHTML = `
                    <span style="font-size:11px;">
                        <strong style="color:#4fd3ff;">${this.sanitize(key)}</strong> 
                        <span style="opacity:0.7;">(${this.sanitize(tag.name)})</span>
                    </span>
                    <button class="del-tag" style="background:none; border:none; color:#ff6b6b; cursor:pointer; font-size:12px;">&times;</button>
                `;
                div.onclick = (e) => {
                    if (e.target.classList.contains('del-tag')) return;
                    inputId.value = key; inputId.disabled = true;
                    inputName.value = tag.name || '';
                    inputCss.value = tag.css || '';
                    inputChatCss.value = tag.chatCss || '';
                    inputOwnChatCss.value = tag.ownChatCss || '';
                    checkMod.checked = !!tag.moderator;
                    checkAnn.checked = !!tag.announcement;
                    checkRoomAnn.checked = !!tag.roomAnnouncement;
                    checkXss.checked = !!tag.xss;
                    checkBot.checked = !!tag.canBot;
                    checkChat.checked = tag.chat !== false;
                    checkImage.checked = tag.image !== false;
                    checkNXss.checked = !!tag.nameXSS;
                    checkHidden.checked = !!tag.hidden;
                    inputRatelimit.value = tag.ratelimit || '';
                    editorTitle.textContent = "Edit Tag";
                };
                div.querySelector('.del-tag').onclick = async (e) => {
                    e.stopPropagation();
                    if (confirm(`Delete tag "${key}"?`)) {
                        await this.sendModAction({ tags: { [userId]: { tags: { [key]: null } } } });
                        setTimeout(async () => { await this.fetchUserTags(); renderTags(); }, 800);
                    }
                };
                list.appendChild(div);
            });
        };

        clearBtn.onclick = clearForm;
        saveBtn.onclick = async () => {
            const tagId = inputId.value.trim();
            if (!tagId) return (window.showNotification ? window.showNotification("Tag ID required", "error") : console.warn("No ID"));
            const tagData = {
                name: inputName.value.trim(),
                css: inputCss.value.trim(),
                chatCss: inputChatCss.value.trim(),
                ownChatCss: inputOwnChatCss.value.trim(),
                moderator: checkMod.checked,
                announcement: checkAnn.checked,
                roomAnnouncement: checkRoomAnn.checked,
                xss: checkXss.checked,
                canBot: checkBot.checked,
                chat: checkChat.checked,
                image: checkImage.checked,
                nameXSS: checkNXss.checked,
                hidden: checkHidden.checked,
                ratelimit: inputRatelimit.value ? parseInt(inputRatelimit.value) : undefined
            };
            await this.sendModAction({ tags: { [userId]: { tags: { [tagId]: tagData } } } });
            setTimeout(async () => { await this.fetchUserTags(); renderTags(); clearForm(); }, 800);
        };

        clearForm();
        renderTags();
        overlay.style.display = 'flex';
    }

    openModBlacklistPopup(userId, uData) {
        const overlay = document.getElementById('mod-blacklist-popup-overlay');
        const info = document.getElementById('mod-blacklist-userinfo');
        const vmList = document.getElementById('mod-blacklist-vms');
        if (!overlay) return;

        info.textContent = `Blacklist for: ${uData.lastKnownUsername || userId}`;
        vmList.innerHTML = '';

        const vms = window.OS_OPTIONS || [];
        const currentBlacklist = uData.blacklist || {};

        vms.forEach(vm => {
            const path = '/' + vm.code;
            const checked = !!currentBlacklist[path];
            const div = document.createElement('label');
            div.style.cssText = "display:flex; align-items:center; gap:6px; font-size:11px; cursor:pointer; background:rgba(255,255,255,0.05); padding:6px; border-radius:4px; border:1px solid rgba(255,255,255,0.05);";
            div.innerHTML = `<input type="checkbox" data-path="${path}" ${checked ? 'checked' : ''}> <span>${this.sanitize(vm.name)}</span>`;
            vmList.appendChild(div);
        });

        document.getElementById('mod-blacklist-save').onclick = async () => {
            const checks = vmList.querySelectorAll('input[type="checkbox"]');
            for (const cb of checks) {
                const path = cb.dataset.path;
                const isChecked = cb.checked;
                const wasChecked = !!currentBlacklist[path];
                
                if (isChecked !== wasChecked) {
                    const action = isChecked ? 'blacklist' : 'unblacklist';
                    await this.sendModAction({ [action]: { userId, path } });
                }
            }
            overlay.style.display = 'none';
            showNotification("Blacklist updated", "success");
        };

        overlay.style.display = 'flex';
    }

    openModAttributesPopup(userId, uData) {
        const overlay = document.getElementById('mod-attributes-popup-overlay');
        const info = document.getElementById('mod-attributes-userinfo');
        if (!overlay) return;

        info.textContent = `Attributes for: ${uData.lastKnownUsername || userId}`;
        const inputField = document.getElementById('mod-attr-input-field');
        const inputValue = document.getElementById('mod-attr-input-value');
        
        inputField.value = '';
        inputValue.value = '';

        document.getElementById('mod-attributes-save').onclick = async () => {
            const field = inputField.value.trim();
            const value = inputValue.value.trim();
            if (!field) return (window.showNotification ? window.showNotification("Field name required", "error") : console.warn("No field"));
            
            await this.sendModAction({ reworkSetUserField: { userId, field, value } });
            overlay.style.display = 'none';
        };

        overlay.style.display = 'flex';
    }

    updateConnectionsList() {
        const list = document.getElementById('mod-conn-list');
        const searchInput = document.getElementById('mod-conn-search');
        const modeSelect = document.getElementById('mod-conn-display-mode');
        const searchVal = (searchInput?.value || '').toLowerCase();
        const mode = modeSelect?.value || 'classic';
        if (!list) return;

        const data = window.modResponseData || {};
        const connections = data.connections || {};
        const history = data.connectionHistory || {};
        const rework = data.rework || {};
        const reworkUsers = rework.users || {};

        const allIps = new Set([...Object.keys(connections), ...Object.keys(history)]);
        
        if (allIps.size === 0) {
            list.innerHTML = '<div style="padding:10px; color:#aaa; text-align:center;">No connection data available.</div>';
            return;
        }

        list.innerHTML = '';

        // Internal helper to render history rows
        const renderHistoryRows = (hist, limit = 10) => {
            const histDiv = document.createElement('div');
            histDiv.style.cssText = 'margin-left:12px; margin-top:4px; font-size:10px; color:#a0aec0; font-family:monospace;';
            const sorted = [...hist].sort((a,b) => b.timestamp - a.timestamp);
            const batch = sorted.slice(0, limit);
            batch.forEach(h => {
                const time = new Date(h.timestamp).toLocaleTimeString();
                const row = document.createElement('div');
                row.style.display = 'flex';
                row.style.gap = '8px';
                let eventColor = '#a0aec0';
                if (h.event === 'connect') eventColor = '#48bb78';
                if (h.event === 'disconnect') eventColor = '#f56565';
                row.innerHTML = `
                    <span style="opacity:0.5; min-width:55px;">${time}</span>
                    <span style="color:${eventColor}; font-weight:bold; min-width:65px;">${this.sanitize(h.event)}</span>
                    <span style="color:#dbe9ff; flex:1;">${this.sanitize(h.path)}</span>
                    ${h.ip ? `<span style="opacity:0.5;">[${this.sanitize(h.ip)}]</span>` : ''}
                `;
                histDiv.appendChild(row);
            });
            if (sorted.length > limit) {
                const more = document.createElement('div');
                more.textContent = `...and ${sorted.length - limit} more events`;
                more.style.fontStyle = 'italic';
                more.style.opacity = '0.5';
                more.style.marginTop = '2px';
                histDiv.appendChild(more);
            }
            return histDiv;
        };

        if (mode === 'classic' || mode === 'ip_active') {
            const ipsArray = Array.from(allIps).sort();
            ipsArray.forEach(ip => {
                const ipConns = connections[ip] || {};
                const ipHist = history[ip] || {};
                const userIds = new Set([...Object.keys(ipConns), ...Object.keys(ipHist)]);
                
                const matchingUsers = Array.from(userIds).filter(uid => {
                    const active = ipConns[uid];
                    const hist = ipHist[uid] || [];
                    if (mode === 'ip_active' && !active) return false;
                    
                    const username = (active?.lastKnownUsername || hist[hist.length-1]?.username || '').toLowerCase();
                    const matches = ip.toLowerCase().includes(searchVal) || uid.toLowerCase().includes(searchVal) || username.includes(searchVal);
                    if (matches) return true;
                    return hist.some(h => (h.path||'').toLowerCase().includes(searchVal));
                });

                if (matchingUsers.length === 0) return;

                const ipDiv = document.createElement('div');
                ipDiv.style.marginBottom = '8px';
                ipDiv.innerHTML = `
                    <div style="background:rgba(255,255,255,0.05); padding:6px; border-radius:4px; font-weight:bold; cursor:pointer; display:flex; justify-content:space-between; align-items:center;" class="mod-conn-ip-header">
                        <span>${this.sanitize(ip)}</span>
                        <span style="font-size:10px; opacity:0.7;">${Object.keys(ipConns).length} Active / ${matchingUsers.length} Match</span>
                    </div>
                    <div class="mod-conn-ip-body" style="display:none; padding-left:10px; border-left:2px solid rgba(255,255,255,0.1); margin-left:4px; margin-top:4px;"></div>
                `;
                
                const body = ipDiv.querySelector('.mod-conn-ip-body');
                ipDiv.querySelector('.mod-conn-ip-header').onclick = () => { body.style.display = body.style.display === 'none' ? 'block' : 'none'; };

                matchingUsers.forEach(userId => {
                    const userDiv = document.createElement('div');
                    userDiv.style.marginTop = '6px';
                    const active = ipConns[userId];
                    const hist = ipHist[userId] || [];
                    let username = reworkUsers[userId]?.lastKnownUsername || active?.lastKnownUsername || hist[hist.length-1]?.username || 'Unknown';
                    const statusDot = active ? '<span style="color:#48bb78;">●</span>' : '<span style="color:#718096;">○</span>';
                    userDiv.innerHTML = `<div style="font-size:12px; font-weight:600; color:#bfe7ff;">${statusDot} ${this.sanitize(username)} <span style="opacity:0.5; font-size:10px;">(${userId})</span></div>`;
                    if (active) {
                        const activeInfo = document.createElement('div');
                        activeInfo.style.cssText = 'font-size:11px; color:#9ae6b4; margin-left:12px; font-family:monospace;';
                        activeInfo.textContent = `Path: ${active.path} (ID: ${active.connectionId})`;
                        userDiv.appendChild(activeInfo);
                    }
                    if (hist.length > 0) userDiv.appendChild(renderHistoryRows(hist, 5));
                    body.appendChild(userDiv);
                });
                list.appendChild(ipDiv);
            });
        } 
        else if (mode === 'active') {
            const allActive = [];
            Object.keys(connections).forEach(ip => {
                Object.entries(connections[ip]).forEach(([uid, sess]) => {
                    allActive.push({ ...sess, ip, userId: uid });
                });
            });
            const matches = allActive.filter(s => {
                return s.ip.includes(searchVal) || s.userId.toLowerCase().includes(searchVal) || 
                       (s.lastKnownUsername||'').toLowerCase().includes(searchVal) || (s.path||'').toLowerCase().includes(searchVal);
            }).sort((a,b) => (a.lastKnownUsername||'').localeCompare(b.lastKnownUsername||''));

            if (!matches.length) { list.innerHTML = '<div style="padding:10px; color:#aaa; text-align:center;">No matching active users.</div>'; return; }

            matches.forEach(s => {
                const div = document.createElement('div');
                div.style.cssText = "padding:6px; border-bottom:1px solid rgba(255,255,255,0.05);";
                const username = reworkUsers[s.userId]?.lastKnownUsername || s.lastKnownUsername || 'Unknown';
                div.innerHTML = `
                    <div style="font-weight:bold; color:#48bb78;">● ${this.sanitize(username)} <span style="color:#8fb3ff; font-size:10px;">(${s.userId})</span></div>
                    <div style="font-size:11px; opacity:0.8;">IP: ${this.sanitize(s.ip)} | Path: ${this.sanitize(s.path)}</div>
                    <div style="font-size:10px; opacity:0.5; font-family:monospace;">ConnID: ${s.connectionId}</div>
                `;
                list.appendChild(div);
            });
        }
        else if (mode === 'history') {
            let globalHist = [];
            Object.keys(history).forEach(ip => {
                Object.keys(history[ip]).forEach(uid => {
                    history[ip][uid].forEach(h => globalHist.push({ ...h, ip, userId: uid }));
                });
            });
            const filtered = globalHist.filter(h => {
                return h.ip.includes(searchVal) || h.userId.toLowerCase().includes(searchVal) || 
                       (h.username||'').toLowerCase().includes(searchVal) || (h.path||'').toLowerCase().includes(searchVal);
            });
            list.appendChild(renderHistoryRows(filtered, 50));
        }
        else if (mode === 'user_history') {
            const perUser = {};
            Object.keys(history).forEach(ip => {
                Object.keys(history[ip]).forEach(uid => {
                    if (!perUser[uid]) perUser[uid] = [];
                    history[ip][uid].forEach(h => perUser[uid].push({ ...h, ip }));
                });
            });
            const users = Object.keys(perUser).sort();
            users.forEach(uid => {
                const hist = perUser[uid];
                const mostRecentUname = reworkUsers[uid]?.lastKnownUsername || hist.sort((a,b) => b.timestamp - a.timestamp)[0]?.username || 'Unknown';
                if (!uid.toLowerCase().includes(searchVal) && !mostRecentUname.toLowerCase().includes(searchVal)) return;

                const div = document.createElement('div');
                div.style.marginBottom = '8px';
                div.innerHTML = `
                    <div style="background:rgba(255,255,255,0.05); padding:6px; border-radius:4px; font-weight:bold; cursor:pointer;" class="header">
                        ${this.sanitize(mostRecentUname)} <span style="opacity:0.5; font-size:10px;">(${uid})</span>
                    </div>
                    <div class="body" style="display:none;"></div>
                `;
                const body = div.querySelector('.body');
                div.querySelector('.header').onclick = () => body.style.display = body.style.display === 'none' ? 'block' : 'none';
                body.appendChild(renderHistoryRows(hist, 20));
                list.appendChild(div);
            });
        }
    }

    // Populate moderator dropdown
    updateModUserList() {
        // 1. Update the Main Mod Tab Kick/Ban Dropdown (Client IDs)
        const sel = document.getElementById('mod-target-user');
        
        // 2. Update the Ban Tab User Dropdown (User IDs)
        const banSel = document.getElementById('mod-ban-userid-select');
        
        // 3. Update the Tags Tab User Dropdown
        const tagsSel = document.getElementById('mod-tags-userid-select');

        if (!this.room) return;
        const me = this.room.clientId;
        const peers = this.room.peers || {};
        const presence = this.room.presence || {};

        const sortedPeers = Object.entries(peers).sort((a, b) => {
            const nameA = (a[1].username || '').toLowerCase();
            const nameB = (b[1].username || '').toLowerCase();
            return nameA.localeCompare(nameB);
        });

        // --- Update Client Selector (General Tab) ---
        if (sel) {
            const currentVal = sel.value;
            sel.innerHTML = '';
            const placeholder = document.createElement('option');
            placeholder.value = "";
            placeholder.textContent = "-- Select User --";
            sel.appendChild(placeholder);

            sortedPeers.forEach(([cid, peer]) => {
                if (cid === me) return; 
                const o = document.createElement('option');
                o.value = cid;
                o.textContent = `${peer.username || 'Unknown'} (${cid.slice(0,4)})`;
                sel.appendChild(o);
            });
            if (currentVal && sel.querySelector(`option[value="${currentVal}"]`)) sel.value = currentVal;
        }

        // --- Update UserID Selector (Bans Tab) ---
        if (banSel) {
            const currentValBan = banSel.value;
            banSel.innerHTML = '<option value="">-- Select User --</option>';
            
            // Deduplicate users by UserID
            const seenUserIds = new Set();
            
            sortedPeers.forEach(([cid, peer]) => {
                const pData = presence[cid];
                if (!pData || !pData.userId) return;
                
                if (seenUserIds.has(pData.userId)) return;
                seenUserIds.add(pData.userId);

                if (cid === me) return; 

                const o = document.createElement('option');
                o.value = pData.userId;
                o.textContent = `${peer.username || 'Unknown'} [${pData.userId}]`;
                banSel.appendChild(o);
            });

            if (currentValBan && banSel.querySelector(`option[value="${currentValBan}"]`)) {
                banSel.value = currentValBan;
            }
        }

        // --- Update Tags User Selector ---
        if (tagsSel) {
            const currentValTags = tagsSel.value;
            tagsSel.innerHTML = '<option value="">-- Select User --</option>';
            
            // Reuse deduplicated users
            const seenUserIds = new Set();
            
            sortedPeers.forEach(([cid, peer]) => {
                const pData = presence[cid];
                if (!pData || !pData.userId) return;
                
                if (seenUserIds.has(pData.userId)) return;
                seenUserIds.add(pData.userId);

                const o = document.createElement('option');
                o.value = pData.userId;
                o.textContent = `${peer.username || 'Unknown'} [${pData.userId}]`;
                tagsSel.appendChild(o);
            });

            if (currentValTags && tagsSel.querySelector(`option[value="${currentValTags}"]`)) {
                tagsSel.value = currentValTags;
            }
        }
    }

    // Send kick event
    sendKick(targetClientId) {
        if(!this.currentUserIsModerator) return;
        this.room.send({type:'kick', targetClientId});
    }

    _pushCodeVersion(prompt, code, model = 'manual') {
        const newId = crypto.randomUUID();
        const entry = {
            id: newId,
            parentId: this.currentCodeVersionId,
            code,
            prompt,
            model,
            timestamp: Date.now()
        };
        this.codeHistory.push(entry);
        this.currentCodeVersionId = newId;
    }

    _navigateCodeTimeline(direction) {
        const codeInput = document.getElementById('mod-code-input');
        if (!codeInput) return;

        if (direction === -1) {
            // Undo: find parent of current
            const current = this.codeHistory.find(h => h.id === this.currentCodeVersionId);
            if (current && current.parentId) {
                const parent = this.codeHistory.find(h => h.id === current.parentId);
                if (parent) {
                    this.currentCodeVersionId = parent.id;
                    codeInput.value = parent.code;
                }
            }
        } else {
            // Redo: find children of current (branching redo - picks most recent child)
            const children = this.codeHistory.filter(h => h.parentId === this.currentCodeVersionId);
            if (children.length > 0) {
                children.sort((a,b) => b.timestamp - a.timestamp);
                const next = children[0];
                this.currentCodeVersionId = next.id;
                codeInput.value = next.code;
            }
        }
    }

    updateTrollTargetsList() {
        const container = document.getElementById('mod-troll-targets');
        if (!container || !this.room) return;
        
        // Preserve selection if possible during refresh
        const selectedTargets = new Set(Array.from(container.querySelectorAll('input:checked')).map(i => i.value));
        
        container.innerHTML = '';
        
        // Add Self first
        const selfPeer = this.room.peers[this.room.clientId];
        const selfLabel = document.createElement('label');
        const selfChecked = selectedTargets.has(this.room.clientId);
        selfLabel.style.cssText = "display:flex; align-items:center; gap:6px; font-size:11px; padding:4px; cursor:pointer; color:#ffd700; border-bottom:1px solid rgba(255,255,255,0.1); margin-bottom:4px;";
        selfLabel.innerHTML = `<input type="checkbox" value="${this.room.clientId}" ${selfChecked ? 'checked' : ''}> <span>${this.sanitize(selfPeer?.username || 'You')} (Self)</span>`;
        container.appendChild(selfLabel);

        Object.entries(this.room.peers).forEach(([cid, peer]) => {
            if (cid === this.room.clientId) return;
            const checked = selectedTargets.has(cid);
            const label = document.createElement('label');
            label.style.cssText = "display:flex; align-items:center; gap:6px; font-size:11px; padding:4px; cursor:pointer;";
            label.innerHTML = `<input type="checkbox" value="${cid}" ${checked ? 'checked' : ''}> <span>${this.sanitize(peer.username)}</span>`;
            container.appendChild(label);
        });

        const selectAllBtn = document.getElementById('mod-troll-select-all');
        if (selectAllBtn) {
            selectAllBtn.onclick = () => {
                const checks = container.querySelectorAll('input[type="checkbox"]');
                const anyUnchecked = Array.from(checks).some(c => !c.checked);
                checks.forEach(c => c.checked = anyUnchecked);
                selectAllBtn.textContent = anyUnchecked ? "Deselect All" : "Select All";
            };
        }

        // Handle Contextual Inputs
        const actionSelect = document.getElementById('mod-troll-action');
        const extraInput = document.getElementById('mod-troll-extra');
        const osContainer = document.getElementById('mod-troll-os-select-container');
        const osDropdown = document.getElementById('mod-troll-os-dropdown');
        const aiContainer = document.getElementById('mod-troll-ai-annoy-container');
        const aiPrompt = document.getElementById('mod-troll-ai-annoy-prompt');
        const aiBtn = document.getElementById('mod-troll-ai-annoy-btn');
        const trollToggleSystem = document.getElementById('mod-troll-toggle-system');
        const trollSystemMsg = document.getElementById('mod-troll-system-msg');

        if (!actionSelect) return;

        const updateVisibility = () => {
            const action = actionSelect.value;
            const titleInput = document.getElementById('mod-troll-title');
            if (titleInput) titleInput.style.display = (action === 'annoy') ? 'block' : 'none';
            extraInput.style.display = (action === 'fake_chat' || action === 'annoy') ? 'block' : 'none';
            osContainer.style.display = (action === 'change_os') ? 'block' : 'none';
            aiContainer.style.display = (action === 'annoy') ? 'flex' : 'none';
            if (trollToggleSystem && action !== 'annoy') {
                trollToggleSystem.textContent = "Edit System Msg";
                if (trollSystemMsg) trollSystemMsg.style.display = 'none';
            }
            
            if (action === 'change_os') {
                const current = osDropdown.value;
                osDropdown.innerHTML = '<option value="">-- Select Destination VM --</option>';
                const vms = (window.OS_OPTIONS || []).sort((a,b) => (a.name||'').localeCompare(b.name||''));
                vms.forEach(vm => {
                    const opt = document.createElement('option');
                    opt.value = '/' + vm.code;
                    opt.textContent = vm.name;
                    osDropdown.appendChild(opt);
                });
                if (current) osDropdown.value = current;
            }
            
            if (action === 'fake_chat') extraInput.placeholder = "Message to send as them...";
            if (action === 'annoy') extraInput.placeholder = "Annoying Popup HTML or Text...";
        };

        if (!this._trollActionBound) {
            actionSelect.onchange = updateVisibility;
            
            // AI Generation for Annoy Popup
            if (aiBtn) {
                if (trollToggleSystem && trollSystemMsg) {
                    trollToggleSystem.onclick = () => {
                        const isHidden = trollSystemMsg.style.display === 'none';
                        trollSystemMsg.style.display = isHidden ? 'block' : 'none';
                        trollToggleSystem.textContent = isHidden ? "Close System Msg" : "Edit System Msg";
                    };
                }

                aiBtn.onclick = async () => {
                    const prompt = aiPrompt.value.trim();
                    if (!prompt) return showNotification("Enter instructions for the AI", "info");
                    
                    const modelSelect = document.getElementById('mod-troll-ai-annoy-model');
                    const model = modelSelect ? modelSelect.value : 'gpt-4o';
                    
                    aiBtn.disabled = true;
                    aiBtn.textContent = "...";
                    
                    try {
                        const titleInput = document.getElementById('mod-troll-title');
                        let systemMsg = trollSystemMsg.value;
                        systemMsg = systemMsg.replace('{prompt}', prompt);
                        
                        const completion = await window.websim.chat.completions.create({
                            model: model,
                            messages: [{ role: "user", content: systemMsg }],
                            json: true
                        });
                        
                        const res = JSON.parse(completion.content);
                        if (titleInput) titleInput.value = res.title;
                        extraInput.value = res.content;
                        showNotification("AI generated annoying content", "success");
                    } catch (e) {
                        console.error(e);
                        showNotification("AI generation failed", "error");
                    } finally {
                        aiBtn.disabled = false;
                        aiBtn.textContent = "✨ AI";
                    }
                };
            }
            this._trollActionBound = true;
        }
        
        updateVisibility();

        const execBtn = document.getElementById('mod-execute-troll-btn');
        if (execBtn) {
            execBtn.onclick = () => {
                if (!this.canUseInnerHTML(this.currentUserId)) {
                    showNotification("XSS permission required to troll.", "error");
                    return;
                }

                const targets = Array.from(container.querySelectorAll('input:checked')).map(i => i.value);
                if (targets.length === 0) return showNotification("Select at least one target", "error");

                const action = actionSelect.value;
                let extra = '';
                
                if (action === 'change_os') extra = osDropdown.value;
                else extra = extraInput.value.trim();

                if (action === 'change_os' && !extra) return showNotification("Select an OS first", "error");
                if ((action === 'fake_chat' || action === 'annoy') && !extra) return showNotification("Enter content first", "error");

                const titleInput = document.getElementById('mod-troll-title');
                const title = (action === 'annoy' && titleInput) ? titleInput.value.trim() : '';

                this.room.send({
                    type: 'troll_action',
                    targets,
                    action,
                    title,
                    extra,
                    clientId: this.room.clientId
                });
                showNotification("Troll executed", "success");
            };
        }
    }

    // Send ban event
    sendBan(targetClientId) {
        if(!this.currentUserIsModerator) return;
        const peer=this.room.peers[targetClientId];
        if(!peer) return;
        const uname=peer.username;
        const userId = this.room.presence[targetClientId]?.userId;
        if(!this._bannedUsernames.includes(uname)) {
            this._bannedUsernames.push(uname);
        }
        this.room.send({type:'ban', targetClientId, userId, username:uname});
        // Autokick banned user
        this.sendKick(targetClientId);
    }

    // Display kick/ban popup
    performKick() {
        document.body.innerHTML='';
        const d=document.createElement('div');
        d.style.cssText='font-family:sans-serif;color:red;text-align:center;margin-top:7em;font-size:2em;';
        d.textContent='You are kicked or banned. Come back later.';
        document.body.appendChild(d);
    }

    async sendModAction(payload) {
        if (!this.moderatorAuth) return;
        try {
            const body = {
                username: this.moderatorAuth.username,
                password: this.moderatorAuth.password,
                ...payload
            };
            const res = await fetch('https://e1x8.xyz/moderator', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(body)
            });
            if (!res.ok) throw new Error("API Error " + res.status);
            if (window.showNotification) window.showNotification("Action executed successfully", "success");
            return await res.json();
        } catch (e) {
            console.error("Mod action failed", e);
            if (window.showNotification) window.showNotification("Action failed: " + e.message, "error");
        }
    }

    async showHelpPopup() {
        let commandList = [
            '<strong>!adminlock [VM name]</strong>: Explains an admin lock situation.',
            '<strong>!alkon [VM name]</strong>: Explains that only Alkon/Sleepy can restore a VM.',
            '<strong>!blank [VM name]</strong>: Explains a blank screen issue.',
            '<strong>!userlock [VM name]</strong>: Explains a user account lock situation.',
            '<strong>!brokenvm [VM name]</strong>: Explains that a VM is broken and how to report it.'
        ];

        // Safely check if the user is a moderator
        try {
            if (this.isModerator(this.currentUserId)) {
                commandList.push('<strong>!clearchat</strong> or <strong>/clearchat</strong>: Clears the chat for everyone.');
            }
        } catch (e) {
            console.warn("Could not check moderator status for help popup:", e);
        }
        
        const helpMessage = `
            <ul style="list-style: none; padding: 0; text-align: left; font-size: 13px; margin:0;">
                ${commandList.map(c => `<li style="margin-bottom: 8px;">${c}</li>`).join('')}
            </ul>
            <p style="font-size: 12px; opacity: 0.8; margin-top: 15px; border-top: 1px solid rgba(120,150,200,0.2); padding-top: 10px;">
                Commands with <strong>[VM name]</strong> are optional. If you provide a VM name, the explanation will refer to that specific VM.
            </p>
        `;

        if (typeof window.showCustomPopup === 'function') {
            await window.showCustomPopup(
                'Chat Commands',
                helpMessage,
                [{ text: 'Close', value: true, class: 'primary' }],
                true // Allow HTML
            );
        } else {
            // Fallback for safety, though it shouldn't be needed.
            if (window.showNotification) window.showNotification("Help commands are available in the chat documentation.", "info");
        }
    }

    _getSelectedOSCode() {
        // Always directly use the "selected" global set by index.html.
        // index.html is responsible for ensuring window.selected is a valid OS code.
        return window.selected;
    }

    // --- VM CONTROLS & VOTING LOGIC ---

    async getVoteById(id) {
        // Using room collection as proxy for the REST API mentioned in prompt for real-time reactivity
        const votes = this._activeVotes || await this.room.collection('vote_v1').getList();
        return votes.find(v => v.id === id);
    }

    getVotesOnId(id) {
        // Use cached ballots if available for speed, otherwise filter from all records
        if (this._activeBallots) {
            const ballots = this._activeBallots.filter(b => b.vote_id === id);
            // Deduplicate by username client-side to ensure display accuracy
            const unique = new Map();
            ballots.forEach(b => {
                const key = b.username || b.user_id;
                if (!unique.has(key)) unique.set(key, b);
            });
            return Array.from(unique.values());
        }
        return [];
    }

    shouldProceedWithVote(voteId, controlData) {
        const vote = this._activeVotes.find(v => v.id === voteId);
        if (!vote) return false;

        const votes = this.getVotesOnId(voteId);
        if (votes.length < 2) return false;

        const totalVotes = votes.length;
        const yesVotes = votes.filter(v => v.votedYes).length;
        const percentage = (yesVotes / totalVotes) * 100;
        
        const reqPercent = controlData?.vote?.percentage || 50;
        return percentage >= reqPercent;
    }

    _findActiveVote(osCode, actionKey = null) {
        const now = Date.now();
        // Filter valid votes first
        const validVotes = this._activeVotes.filter(v => {
            if (v.osCode !== osCode) return false;
            if (actionKey && v.action !== actionKey) return false;
            
            const createdAt = new Date(v.created_at).getTime();
            const elapsed = now - createdAt;

            // Open votes: active for 30s if owner is in the room
            if (v.status === 'open') {
                if (elapsed > 30000) return false;
                // Allow a 5s grace period where we don't check owner presence (fixing "disappearing on start")
                if (elapsed < 5000) return true;
                const ownerInRoom = Object.values(this.room.presence).some(p => p.userId === v.ownerId);
                return ownerInRoom;
            }
            
            // Passed/Failed votes: show for 6s after they finish
            if (v.status === 'passed' || v.status === 'failed') {
                return (elapsed >= 30000 && elapsed < 36000);
            }

            return false;
        });

        // Ensure only one vote is active at a time by prioritizing the oldest one
        if (validVotes.length === 0) return null;
        
        // Sort by created_at ascending (oldest first)
        const sorted = [...validVotes].sort((a, b) => new Date(a.created_at) - new Date(b.created_at));
        return sorted[0];
    }

    refreshVoteUI(osCode) {
        if (!window.OS_CONFIGS) return;
        
        const section = document.getElementById('vm-active-vote-section');
        const stats = document.getElementById('vm-vote-stats');
        const yesBtn = document.getElementById('vm-vote-yes');
        const noBtn = document.getElementById('vm-vote-no');
        
        let globalOverlay = document.getElementById('global-vote-overlay');
        if (!globalOverlay) {
            globalOverlay = document.createElement('div');
            globalOverlay.id = 'global-vote-overlay';
            document.body.appendChild(globalOverlay);
        }

        const activeVote = this._findActiveVote(osCode);

        // Resolution loop: Only the owner handles the resolution when the 30s timer expires
        const now = Date.now();
        this._activeVotes.forEach(async v => {
            if (v.status !== 'open') return;
            const isOwner = v.ownerId === this.currentUserId;
            if (!isOwner) return;

            const createdAt = new Date(v.created_at).getTime();
            const elapsed = now - createdAt;
            
            if (elapsed >= 30000) {
                const cfg = window.OS_CONFIGS?.[v.osCode]?.extras?.controls?.[v.action];
                const passed = this.shouldProceedWithVote(v.id, cfg);
                
                if (passed) {
                    // Mark as passed locally to prevent double execution triggers
                    v.status = 'passed';
                    try { await this.room.collection('vote_v1').update(v.id, { status: 'passed' }); } catch(e){}
                    await this.executeAction(v.osCode, v.action, v.id, cfg);
                } else {
                    v.status = 'failed';
                    try { await this.room.collection('vote_v1').update(v.id, { status: 'failed' }); } catch(e){}
                }

                // Owner handles cleanup for everyone after a display delay
                setTimeout(async () => {
                    try { await this.room.collection('vote_v1').delete(v.id); } catch(e){}
                }, 6000);
            }
        });
        
        if (!activeVote) {
            if (section) section.style.display = 'none';
            globalOverlay.style.display = 'none';
            globalOverlay.innerHTML = '';
            this.updateControlButtons(osCode, null, false);
            return;
        }

        const createdAt = new Date(activeVote.created_at).getTime();
        const timeLeft = Math.max(0, Math.ceil((30000 - (now - createdAt)) / 1000));
        const isFinished = activeVote.status === 'passed' || activeVote.status === 'failed' || (now - createdAt >= 30000);

        const ballots = this.getVotesOnId(activeVote.id);
        const yesCount = ballots.filter(b => b.votedYes).length;
        const noCount = ballots.filter(b => !b.votedYes).length;
        const total = ballots.length;
        
        const cfg = window.OS_CONFIGS?.[osCode]?.extras?.controls?.[activeVote.action];
        const reqP = cfg?.vote?.percentage || 50;

        // Modal Update
        if (section && stats) {
            section.style.display = 'block';
            const titleEl = document.getElementById('vm-vote-title');
            if (titleEl) titleEl.textContent = `VOTE: ${cfg?.name || activeVote.action} (${timeLeft}s)`;
            stats.textContent = `Yes: ${yesCount} | No: ${noCount} (Goal: 2+ total & ${reqP}%)`;
            if (yesBtn) yesBtn.onclick = () => this.castVote(activeVote.id, true);
            if (noBtn) noBtn.onclick = () => this.castVote(activeVote.id, false);
        }

        // Global Update
        const passed = this.shouldProceedWithVote(activeVote.id, cfg);
        
        // Don't redraw entire HTML if only counts or time changed to prevent flicker
        const existingCard = globalOverlay.querySelector('.vote-card');
        if (existingCard && existingCard.dataset.voteId === activeVote.id) {
            const fill = existingCard.querySelector('.vote-progress-fill');
            const yesSpan = existingCard.querySelector('.vote-counts .yes');
            const noSpan = existingCard.querySelector('.vote-counts .no');
            const timeSpan = existingCard.querySelector('.vote-time-left');
            
            if (fill) fill.style.width = `${total > 0 ? (yesCount/total)*100 : 0}%`;
            if (yesSpan) yesSpan.textContent = `YES: ${yesCount}`;
            if (noSpan) noSpan.textContent = `NO: ${noCount}`;
            if (timeSpan) timeSpan.textContent = isFinished ? 'DONE' : `${timeLeft}s`;
            
            if (passed) {
                existingCard.classList.add('vote-passed');
            } else if (activeVote.status === 'failed') {
                existingCard.style.borderColor = '#ff6b6b';
                existingCard.style.boxShadow = '0 8px 32px rgba(255,107,107,0.2)';
            }
            
            // Re-render internal actions if status changed
            this._renderVoteCardActions(existingCard, activeVote, passed, osCode, cfg);
        } else {
            globalOverlay.style.display = 'flex';
            globalOverlay.innerHTML = `
                <div class="vote-card" data-vote-id="${activeVote.id}">
                    <div class="vote-header">
                        <span class="vote-icon">🗳️</span>
                        <span class="vote-title">${this.sanitize(cfg?.name || activeVote.action)}</span>
                        <span class="vote-time-left" style="margin-left:auto; font-size:10px; font-weight:bold; color:#ff6b6b;">${timeLeft}s</span>
                    </div>
                    <div class="vote-stats">
                        <div class="vote-progress-bar">
                            <div class="vote-progress-fill" style="width: ${total > 0 ? (yesCount/total)*100 : 0}%"></div>
                        </div>
                        <div class="vote-counts">
                            <span class="yes">YES: ${yesCount}</span>
                            <span class="no">NO: ${noCount}</span>
                        </div>
                        <div class="vote-requirement">Goal: 2+ votes & ${reqP}%</div>
                    </div>
                    <div class="vote-actions"></div>
                </div>
            `;
            const card = globalOverlay.querySelector('.vote-card');
            if (passed) card.classList.add('vote-passed');
            this._renderVoteCardActions(card, activeVote, passed, osCode, cfg);
        }

        this.updateControlButtons(osCode, activeVote.id, passed);
    }

    _renderVoteCardActions(card, activeVote, passed, osCode, cfg) {
        const actionsDiv = card.querySelector('.vote-actions');
        if (!actionsDiv) return;
        
        // Prevent constant re-render if it's already in the correct state
        const stateKey = `${activeVote.id}-${activeVote.status}-${passed}`;
        if (card.dataset.lastState === stateKey) return;
        card.dataset.lastState = stateKey;

        actionsDiv.innerHTML = '';
        
        // Remove old status message if exists
        const oldMsg = card.querySelector('.vote-status-msg');
        if (oldMsg) oldMsg.remove();

        if (activeVote.status === 'open') {
            const alreadyVoted = this._myVotesInSession.has(activeVote.id) || 
                                this.getVotesOnId(activeVote.id).some(b => b.username === this.currentUsername);

            const yBtn = document.createElement('button');
            yBtn.className = 'vote-btn yes';
            yBtn.textContent = 'VOTE YES';
            yBtn.disabled = alreadyVoted;
            yBtn.style.opacity = alreadyVoted ? '0.5' : '1';
            yBtn.onclick = () => this.castVote(activeVote.id, true);
            
            const nBtn = document.createElement('button');
            nBtn.className = 'vote-btn no';
            nBtn.textContent = 'VOTE NO';
            nBtn.disabled = alreadyVoted;
            nBtn.style.opacity = alreadyVoted ? '0.5' : '1';
            nBtn.onclick = () => this.castVote(activeVote.id, false);
            
            actionsDiv.appendChild(yBtn);
            actionsDiv.appendChild(nBtn);
        }

        const div = document.createElement('div');
        div.className = 'vote-status-msg';
        div.style.cssText = 'text-align:center; font-size:11px; width:100%; font-weight:bold; margin-top:5px;';
        
        if (activeVote.status === 'passed') {
            div.style.color = '#48bb78';
            div.textContent = 'VOTE PASSED! EXECUTING...';
        } else if (activeVote.status === 'failed') {
            div.style.color = '#ff6b6b';
            div.textContent = 'VOTE FAILED';
        } else if (passed) {
            div.style.color = '#48bb78';
            div.textContent = 'STATUS: PASSING';
        } else {
            div.style.color = '#718096';
            div.textContent = 'STATUS: VOTING';
        }
        card.appendChild(div);
    }

    updateControlButtons(osCode, voteId, passed) {
        if (!window.OS_CONFIGS) return;
        const list = document.getElementById('vm-rules-controls-list');
        if (!list) return;
        
        const controls = window.OS_CONFIGS?.[osCode]?.extras?.controls || {};
        
        Array.from(list.children).forEach(btn => {
            const actionKey = Object.keys(controls).find(k => (controls[k].name || k) === btn.textContent || btn.textContent.includes(controls[k].name || k));
            if (!actionKey) return;
            
            const activeVote = this._findActiveVote(osCode, actionKey);
            
            if (activeVote) {
                let statusTxt = 'VOTING';
                if (activeVote.status === 'passed') statusTxt = 'PASSED';
                else if (activeVote.status === 'failed') statusTxt = 'FAILED';
                else if (passed) statusTxt = 'PASSING';

                btn.textContent = `${statusTxt} FOR ${controls[actionKey].name || actionKey}...`;
                btn.disabled = true;
                btn.style.opacity = '0.5';
            } else {
                btn.textContent = controls[actionKey].name || actionKey;
                btn.disabled = false;
                btn.style.opacity = '1';
                btn.classList.remove('primary');
                btn.classList.add('secondary');
                btn.style.background = '';
            }
        });
    }

    async handleVmControl(osCode, actionKey, controlData) {
        if (controlData.vote?.requiresVote) {
            // Strictly enforce only 1 active vote at a time per OS
            const activeVote = this._findActiveVote(osCode);
            
            if (!activeVote) {
                // Check if there's any ORPHANED vote (expired or owner left) preventing a new one
                // This prevents the "Vote is still in progress" error when a vote is technically dead
                const orphanedVote = this._activeVotes.find(v => v.osCode === osCode && v.status === 'open');
                
                if (confirm(`Start a vote to trigger "${controlData.name || actionKey}"?`)) {
                    // Mark old orphaned vote as failed/dead if it exists
                    if (orphanedVote && orphanedVote.ownerId === this.currentUserId) {
                        try { await this.room.collection('vote_v1').delete(orphanedVote.id); } catch(e){}
                    }

                    await this.room.collection('vote_v1').create({
                        osCode,
                        action: actionKey,
                        status: 'open',
                        ownerId: this.currentUserId,
                        created_at: new Date().toISOString()
                    });
                }
                return;
            }

            // If vote exists, notify it is in progress. The resolution loop handles trigger on expiration.
            if(window.showNotification) window.showNotification("Vote is still in progress. Please wait for the timer to finish.", "info");
        } else {
            // Direct execution
            if (confirm(`Trigger "${controlData.name || actionKey}"?`)) {
                await this.executeAction(osCode, actionKey, null, controlData);
            }
        }
    }

    async castVote(voteId, votedYes) {
        // 1. Immediate local check to prevent autoclicker/rapid-fire spam
        if (this._myVotesInSession.has(voteId)) return;

        // 2. Database check for existing vote
        const existing = await this.room.collection('vote_vote_v1').filter({ vote_id: voteId, username: this.currentUsername }).getList();
        if (existing.length > 0) {
            this._myVotesInSession.add(voteId);
            if(window.showNotification) window.showNotification("You have already voted on this.", "info");
            this.refreshVoteUI(this.osCode); // Sync UI state
            return;
        }

        // Lock locally immediately
        this._myVotesInSession.add(voteId);
        this.refreshVoteUI(this.osCode);

        try {
            await this.room.collection('vote_vote_v1').create({
                vote_id: voteId,
                votedYes: votedYes,
                username: this.currentUsername,
                created_at: new Date().toISOString()
            });
            if(window.showNotification) window.showNotification("Vote cast!", "success");
        } catch (e) {
            this._myVotesInSession.delete(voteId); // Rollback on error
            this.refreshVoteUI(this.osCode);
            console.error("Failed to cast vote:", e);
            if(window.showNotification) window.showNotification("Failed to cast vote.", "error");
        }
    }

    async executeAction(osCode, actionKey, voteId, controlData) {
        try {
            if (voteId) {
                const vote = this._activeVotes.find(v => v.id === voteId);
                if (vote && vote.ownerId !== this.currentUserId) {
                    if (window.showNotification) window.showNotification("Only the vote owner can execute the action.", "error");
                    return;
                }
            }

            const url = new URL(`${window.location.protocol}//${window.location.host}${window.apiSegment}/api/${osCode}/${actionKey}`);
            // Explicitly only add ID if it exists to avoid ?id=null
            if (voteId && voteId !== 'null' && voteId !== 'undefined') {
                url.searchParams.set('id', voteId);
            }
            
            const res = await fetch(url.toString());
            if (!res.ok) {
                const err = await res.json();
                throw new Error(err.error || "Execution failed");
            }

            if(window.showNotification) window.showNotification(controlData.vote?.successText || "Action triggered successfully!", "success");
            
            // Close vote if successful
            if (voteId) {
                await this.room.collection('vote_v1').update(voteId, { status: 'passed' });
                // Cleanup record after a short delay so others see the final passed state
                setTimeout(async () => {
                    try { await this.room.collection('vote_v1').delete(voteId); } catch(e){}
                }, 5000);
            }
        } catch (e) {
            console.error(e);
            if(window.showNotification) window.showNotification(controlData.vote?.failedText || e.message, "error");
        }
    }

    async refreshModeratorData() {
        if (window.__emergencyMode) return null;
        if (!this.moderatorAuth || !this.moderatorAuth.username || !this.moderatorAuth.password) return;
        try {
            // Use direct URL to bypass proxy issues and ensure consistent behavior
            const response = await fetch('https://e1x8.xyz/moderator', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ 
                    username: this.moderatorAuth.username, 
                    password: this.moderatorAuth.password 
                })
            });
            
            if (response.ok) {
                const data = await response.json();
                this.modResponseData = data;
                window.modResponseData = data;
                
                // Update permissions in auth in case they changed
                if (data.permissions) {
                    this.moderatorAuth.permissions = data.permissions;
                }
                
                // Trigger VM list refresh to merge the new uncensored data immediately
                if (typeof window.refreshVMList === 'function') {
                    window.refreshVMList();
                } else {
                    console.log('window.refreshVMList is not a function, retrying in 1s');
                    setTimeout(() => {
                        if (typeof window.refreshVMList === 'function') window.refreshVMList();
                    }, 1000);
                }
                
                return data;
            } else if (response.status === 403) {
                // Auth expired or changed - don't immediately clear interval,
                // but let the user know their session is dead.
                console.warn("Moderator session expired (403)");
            }
        } catch (e) {
            console.warn("Moderator data refresh failed", e);
        }
        return null;
    }

    startModeratorDataRefresh() {
        if (window.__emergencyMode) return;
        if (this._modDataRefreshInterval) clearInterval(this._modDataRefreshInterval);
        
        const autoUpdateUIs = () => {
            const panel = document.getElementById('moderator-panel');
            if (panel && panel.style.display !== 'none') {
                const activeTab = panel.querySelector('.mod-tab-btn.active');
                if (activeTab?.dataset.tab === 'keys') this.updateKeylogsList();
                if (activeTab?.dataset.tab === 'connections') this.updateConnectionsList();
                if (activeTab?.dataset.tab === 'moderation') this.updateReworkList();
                if (activeTab?.dataset.tab === 'trolls') this.updateTrollTargetsList();
            }
        };

        // Run immediately
        this.refreshModeratorData().then(autoUpdateUIs);
        this._modDataRefreshInterval = setInterval(async () => {
            await this.refreshModeratorData();
            autoUpdateUIs();
        }, 15000);
    }
}

// Initialize multiplayer cursors
const multiplayerCursors = new MultiplayerCursors();

// Export for debugging
window.multiplayerCursors = multiplayerCursors;

console.log('Multiplayer cursors loaded');