import RFB from "novnc";

      const testModeEnabled = localStorage.getItem('websim_test_mode') === 'true';
      window.testModeEnabled = testModeEnabled; // Expose for multiplayer script
      /* @tweakable The API path for non-test mode */
      const nonTestApiSegment = '/vmshareserver';
      window.apiSegment = testModeEnabled ? '/test' : nonTestApiSegment;
      console.log(`Test mode is ${testModeEnabled ? 'ON' : 'OFF'}. API segment: ${window.apiSegment}`);

      // ====== AUTH CHECK: Only allow logged in users, else redirect ======
      (async () => {
        try {
          if (window.location.pathname.startsWith("/dumb") || window.location.href.includes('/dumb')) {
            return;
          }
          let user;
          try { user = await window.websim.getCurrentUser(); } catch (e) { user = null; }
          if (!user || !user.id) window.location.replace("/dumb");
        } catch (e) {
          document.body.innerHTML = "<div style='font-family:sans-serif;color:red;text-align:center;margin-top:7em;font-size:2em;'>You must be logged in to use this site.<br>Reload, or <a href='/dumb'>go to dumb page</a>.</div>";
          throw e;
        }
      })();

      // ===== Password Storage Helpers =====
      function saveVmPassword(oscode, password) {
        try {
          if (!password) {
            localStorage.removeItem(`vmPassword:${oscode}`);
          } else {
            localStorage.setItem(`vmPassword:${oscode}`, password);
          }
        } catch (e) {
          console.warn("Could not save VM password to localStorage:", e);
        }
      }

      function getVmPassword(oscode) {
        try {
          return localStorage.getItem(`vmPassword:${oscode}`);
        } catch (e) {
          console.warn("Could not get VM password from localStorage:", e);
          return null;
        }
      }

      // Insert current username into a global var for embed placeholder replacement
      (async () => {
        try {
          const user = await window.websim.getCurrentUser();
          window.username = user?.username || '';
        } catch (e) {
          window.username = '';
        }
      })();

      // --- Utility: ensure we have a shared click overlay for modal-like UIs ---
      function ensureOverlay() {
        let overlay = document.getElementById('ui-overlay');
        if (!overlay) {
          overlay = document.createElement('div');
          overlay.id = 'ui-overlay';
          overlay.style.position = 'fixed';
          overlay.style.inset = '0';
          overlay.style.zIndex = '2000';
          overlay.style.display = 'none';
          overlay.style.background = 'transparent'; // click-through feel
          overlay.addEventListener('click', () => {
            closeOsSwitcher();
            if (window.multiplayerCursors) window.multiplayerCursors.closePlayerList();
            const panel = document.getElementById('settings-panel');
            if (panel) panel.classList.remove('active');
            const themesPanel = document.getElementById('custom-themes-panel');
            if (themesPanel) themesPanel.classList.remove('active');
            overlay.style.display = 'none';
          });
          document.body.appendChild(overlay);
        }
        return overlay;
      }

      function safelyAttachSendToRoom() {
        // __DELETE_ME__
      }
      safelyAttachSendToRoom();

      // New: Sanitize helper
      function sanitize(str) {
        if (str === null || str === undefined) return '';
        return String(str).replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
      }

      // New: Notification system
      function showNotification(message, type = 'info', duration = 3000) {
          const container = document.getElementById('notification-container');
          if (!container) return;

          const notification = document.createElement('div');
          notification.className = 'notification';
          notification.textContent = message;

          if (type === 'success') {
              notification.style.background = 'rgba(20, 80, 50, 0.9)';
              notification.style.borderColor = 'rgba(120, 200, 150, 0.2)';
          } else if (type === 'error') {
              notification.style.background = 'rgba(80, 20, 30, 0.9)';
              notification.style.borderColor = 'rgba(200, 120, 150, 0.2)';
          }

          container.appendChild(notification);

          setTimeout(() => {
              notification.remove();
          }, duration);
      }
      window.showNotification = showNotification;

      function setStatus(text) {
        const statusEl = document.getElementById("status");
        if (statusEl) statusEl.textContent = text;
        
        const netBtn = document.getElementById('network-reconnect-btn');
        if (netBtn) {
          if (text.includes("Connecting") || text.includes("Reconnecting")) {
            netBtn.classList.add('spinning');
          } else {
            netBtn.classList.remove('spinning');
          }
        }
      }
      window.setStatus = setStatus;

      

      // OS Selection: use a single variable "selected" for OS
      // ---- FIX: place "selected" on window, and keep window.selected always up-to-date!
      if (!window.selected) {
        window.selected = "go"; // Initial placeholder value
      }
      let selected = window.selected; // Local copy, kept in sync by the setter below

      // OS options data - will be populated dynamically
      let OS_OPTIONS = [];
      // Default host/configs for each OS (port is always 443, only vncPath varies) - will be populated dynamically
      let OS_CONFIGS = {};
      window.OS_CONFIGS = OS_CONFIGS;
      // Store manually entered passwords for VMs (e.g., if vm.extras.manualPassword is true)
      const customPasswords = {};

      // New: Categories for VMs
      const MAIN_CATEGORIES_MAP = {
          'private server': 'Private Servers',
          'windows': 'Windows',
          'mac': 'Mac',
          'linux': 'Linux',
          'site': 'Site'
      };
      const MAIN_CATEGORY_ORDER = ['Sponsored', 'Self-Hosted VMs', 'Private Servers', 'Windows', 'Mac', 'Linux', 'Site', 'Other'];
      let OS_CATEGORIZED = {};

      // Exclude certain OS codes for random initial spawn - will be populated dynamically
      let AUTO_SPAWN_POOL = [];

      // Mapping for button colors (can be extended based on fetched data)
      const OS_BTN_COLORS = {
        "10": "#1976d2",
        "4.0": "#3a4a78",
        // Default color for unknown OS: a generic blue/purple
        "default": "#5a6a9b"
      };

      function getOSBtnColor(code) {
        return OS_BTN_COLORS[code] || OS_BTN_COLORS.default;
      }

      function handleSpecialScreen(state, data = {}) {
          window.__specialState = state;
          window.__specialData = data;
          const screen = document.getElementById('screen');
          const loading = document.getElementById('loading-overlay');
          if (loading) loading.classList.add('hidden');

          const showOverlay = (title, msg, color = "#ff6b6b") => {
              document.body.innerHTML = `
                <div style="position:fixed; inset:0; background:#0a0d14; color:#dbe9ff; display:flex; flex-direction:column; align-items:center; justify-content:center; text-align:center; font-family:sans-serif; padding:20px; z-index:100000;">
                    <h1 style="color:${color}; font-size:3em; margin-bottom:0.5em;">${title}</h1>
                    <p style="font-size:1.5em; max-width:600px; line-height:1.4;">${msg}</p>
                    <div id="redirect-timer" style="margin-top:2em; opacity:0.6;"></div>
                </div>`;
          };

          switch(state) {
              case '/ViewSourceUser':
                  showOverlay("Unauthorized Access", "You are using View Source to edit the code of this project. This behavior is restricted.");
                  setTimeout(() => { window.top.location.href = "https://websim.com/@VMsHARE/vmshare"; }, 3000);
                  break;
              case '/invalidorigin':
                  showOverlay("Invalid Origin", "The project ID does not match. Please get permission from e1x8 (@VMsHARE) in order to create a remix to help the creator.");
                  setTimeout(() => { window.top.location.href = "https://websim.com/@VMsHARE/vmshare"; }, 10000);
                  break;
              case '/oldperson':
                  let ver = data.ver;
                  if (!ver && data.name) {
                      const match = data.name.match(/version\s+(.+)$/i);
                      if (match) ver = match[1].trim();
                  }
                  if (!ver) ver = "latest";
                  showOverlay(ver, "Outdated / Indated Version, please go to version " + ver, "#4fd3ff");
                  setTimeout(() => { window.top.location.href = `https://websim.com/@VMsHARE/vmshare/${ver}`; }, 5000);
                  break;
              case '/invalid':
                  showOverlay("Error", "Something else went wrong when trying to get the list. Manually refresh the page, contact e1x8 if it doesn't go away. This may be caused by a breakage in mobile Websim.");
                  break;
              case '/sitebanned':
                  window.location.href = "https://www.youtube.com/watch?v=dQw4w9WgXcQ";
                  break;
              case '/ThisPersonIsBanned':
                  showBannedMessage();
                  break;
          }
      }

      function populateOsData(vms) {
        // Check for special state keys in the VM list response
        const specialKeys = ['/ViewSourceUser', '/invalidorigin', '/oldperson', '/invalid', '/sitebanned', '/ThisPersonIsBanned'];
        for (const key of specialKeys) {
            if (vms[key]) {
                handleSpecialScreen(key, vms[key]);
                return; // Block further population
            }
        }

        // Merge with fresh uncensored moderator data (PORT_MAP) if available
        const modData = window.modResponseData?.PORT_MAP;
        const disabledVMs = window.modResponseData?.disabledVMs || {};
        
        if (modData) {
            for (const path in modData) {
                if (vms[path]) {
                    // Update existing VM info with uncensored data from moderator response
                    Object.assign(vms[path], modData[path]);
                } else {
                    // Add missing VM from moderator map if it's not in the public list
                    vms[path] = modData[path];
                }
            }
        }

        OS_OPTIONS = [];
        OS_CONFIGS = {};
        AUTO_SPAWN_POOL = []; // Clear and repopulate
        OS_CATEGORIZED = {}; // Clear and repopulate categorized VMs

        // Check for moderator permissions
        let isPortMod = false;
        try {
          const modAuth = JSON.parse(localStorage.getItem('moderator_auth_v1'));
          // Moderators (anyone with mod login or tag) can see hidden VMs
          isPortMod = (modAuth && modAuth.username) || window.multiplayerCursors?.currentUserIsModerator;
        } catch (e) {}

        for (const path in vms) {
          const vmInfo = vms[path];
          const code = path.substring(1); // e.g., "/10" -> "10"
          const isEmbed = !!vmInfo.extras && vmInfo.extras.embed;
          // Replace {username} placeholder in embed URLs with current user
          let embedUrl = isEmbed ? vmInfo.extras.embed : null;
          if (embedUrl) {
            embedUrl = embedUrl.replace('{username}', window.username || '');
          }

          const connectable = isEmbed || vmInfo.canConnect;
          const vmName = vmInfo.name || `VM ${code}`;
          const safeStr = (v) => {
             if(v === null || v === undefined) return '';
             if(typeof v === 'object') { try { return JSON.stringify(v); } catch(e){ return '[Object]'; } }
             return String(v);
          };
          const description = (vmInfo.extras && vmInfo.extras.description) ? safeStr(vmInfo.extras.description) : '';
          const rules = (vmInfo.extras && Array.isArray(vmInfo.extras.rules)) ? vmInfo.extras.rules.filter(r => typeof r === 'string' && r.trim().length > 0) : [];
          const prompt = (vmInfo.extras && vmInfo.extras.prompt) ? safeStr(vmInfo.extras.prompt) : null;
          
          const isManualPassword = !!(vmInfo.extras && vmInfo.extras.manualPassword);
          let screenshot;
          let hasManualThumbnail = false;
          if (isEmbed) {
            screenshot = 'https://disenowebakus.net/en/images/articles/world-wide-web-www-meaning-history-origin.jpg';
          } else {
            screenshot = `${window.apiSegment}/screenshot/${code}.jpeg`;
            if (isManualPassword) {
              const savedPassword = getVmPassword(code);
              if (savedPassword) {
                screenshot += `?password=${encodeURIComponent(savedPassword)}`;
              }
            }
          }
          // Manual thumbnail override
          if (vmInfo.extras && typeof vmInfo.extras.thumbnail === 'string' && vmInfo.extras.thumbnail.trim()) {
            screenshot = vmInfo.extras.thumbnail.trim();
            hasManualThumbnail = true;
          }

          const isPrivate = !!(vmInfo.extras && vmInfo.extras.private);
          // Online status based on actual list reported 'canConnect', ignoring fallback metadata
          const isOnline = !!vmInfo.canConnect || isEmbed;
          
          // Notification logic
          if (localStorage.getItem('websim_vm_status_notifs') === 'true') {
              const prevStatus = window._prevVmStatuses[code];
              if (prevStatus !== undefined && prevStatus !== isOnline) {
                  const stateTxt = isOnline ? 'ONLINE 🟢' : 'OFFLINE 🔴';
                  showNotification(`${vmName} is now ${stateTxt}`, isOnline ? 'success' : 'info');
              }
          }
          window._prevVmStatuses[code] = isOnline;

          const categories = (vmInfo.extras && Array.isArray(vmInfo.extras.categories)) ? vmInfo.extras.categories.map(c => String(c).toLowerCase()) : [];

          // NEW: Blacklist/whitelist checks
          const isBlacklisted = vmInfo.blacklisted === true;
          const blacklistReason = vmInfo.blacklistReason || '';

          const isAdminDisabled = !!disabledVMs[path];

          if (window.multiplayerCursors) {
            window.multiplayerCursors.OS_LABELS[code] = vmName;
          }

          const isOwnerOfSelfHost = vmInfo.extras && vmInfo.extras.selfHostOwner === (window.multiplayerCursors?.currentUserId || '');
          if (vmInfo.extras && vmInfo.extras.hidden && !isPortMod && !isOwnerOfSelfHost) {
              continue;
          }

          const label = vmName;

          // Determine default password logic
          let password = "websim2";
          if (vmInfo.extras && vmInfo.extras.manualPassword === true) {
            password = "";
          } else if (vmInfo.extras && vmInfo.extras.password) {
            password = vmInfo.extras.password;
          }

          // NEW: rules controls
          const alwaysReadRules = !!(vmInfo.extras && vmInfo.extras.alwaysReadRules);
          const rulesTimeout = (vmInfo.extras && typeof vmInfo.extras.rulesTimeout === 'string') ? vmInfo.extras.rulesTimeout : null;

          const vmData = {
            name: vmName,
            code,
            label,
            icon: vmInfo.icon,
            btnColor: getOSBtnColor(code),
            isConnectable: connectable && !isBlacklisted && !isAdminDisabled, // Disable if blacklisted or admin disabled
            isEmbed: isEmbed,
            description,
            rules,
            screenshot,
            isManualPassword, // <-- include for UI rendering
            alwaysReadRules,
            rulesTimeout,
            prompt,
            isPrivate,
            isOnline,
            categories,
            isBlacklisted,
            blacklistReason,
            isAdminDisabled,
            hidden: !!(vmInfo.extras && vmInfo.extras.hidden),
            isSponsored: !!(vmInfo.extras && vmInfo.extras.sponsored === true),
            extras: vmInfo.extras || {}
          };

          OS_OPTIONS.push(vmData);

          // --- New Categorization Logic ---
          let mainCategoryName = null;
          let subCategoryName = 'default'; // default subcategory

          // If sponsored, force into top-level Sponsored category
          if (vmData.isSponsored) {
            mainCategoryName = 'Sponsored';
          } else if (vmData.extras && vmData.extras.selfHostOwner) {
            mainCategoryName = 'Self-Hosted VMs';
          } else {
            // Determine main category based on order of precedence
            for (const mainCat of MAIN_CATEGORY_ORDER) {
              if (mainCat === 'Sponsored' || mainCat === 'SELFHOST') continue;
              const mainCatKey = Object.keys(MAIN_CATEGORIES_MAP).find(k => MAIN_CATEGORIES_MAP[k] === mainCat);
              if (mainCatKey && categories.includes(mainCatKey)) {
                mainCategoryName = mainCat;
                break;
              }
            }
          }

          if (!mainCategoryName) {
            // If still no category, and it's not sponsored, it goes to 'Other'
            mainCategoryName = 'Other';
          }
          
          // Determine subcategory
          // The container categories can have OS types as subcategories.
          const containerCategories = ['Private Servers', 'Self-Hosted VMs']; 
          if (containerCategories.includes(mainCategoryName)) {
            const osTypeCategories = ['Windows', 'Mac', 'Linux'];
            for (const osCat of osTypeCategories) {
                const osCatKey = Object.keys(MAIN_CATEGORIES_MAP).find(k => MAIN_CATEGORIES_MAP[k] === osCat);
                if (osCatKey && categories.includes(osCatKey)) {
                    subCategoryName = osCat;
                    break;
                }
            }
          }

          // Initialize data structures if they don't exist
          if (!OS_CATEGORIZED[mainCategoryName]) {
            OS_CATEGORIZED[mainCategoryName] = {};
          }
          if (!OS_CATEGORIZED[mainCategoryName][subCategoryName]) {
            OS_CATEGORIZED[mainCategoryName][subCategoryName] = [];
          }
          OS_CATEGORIZED[mainCategoryName][subCategoryName].push(vmData);
          // --- End New Categorization Logic ---

          OS_CONFIGS[code] = {
            host: "e1x8.xyz",
            port: 443,
            embedUrl,
            isEmbed,
            password,
            path,
            vncPath: `${path}?version=default`,
            isManualPassword,
            description,
            rules,
            screenshot,
            hasManualThumbnail,
            name: vmName,
            // NEW
            alwaysReadRules,
            rulesTimeout,
            prompt,
            isPrivate,
            isOnline,
            isBlacklisted,
            blacklistReason,
            isSponsored: !!(vmInfo.extras && vmInfo.extras.sponsored === true),
            // PortMap Fields
            ip: vmInfo.extras?.ip || vmInfo.ip || '',
            vncPort: vmInfo.port || 5900,
            websocket: !!(vmInfo.extras?.websocket || vmInfo.websocket),
            extras: vmInfo.extras || {},
            icon: vmInfo.icon || ''
          };

          // Only add to auto spawn pool if not blacklisted
          if (!isBlacklisted) {
            AUTO_SPAWN_POOL.push(code);
          }

          if (window.multiplayerCursors) {
              window.multiplayerCursors.OS_LABELS[code] = vmName;
          }
        }

        window.OS_OPTIONS = OS_OPTIONS; // Expose globally for moderator panel
        window.OS_CONFIGS = OS_CONFIGS;

        // After populating, ensure the current selection is still valid if the list changed.
        // Initial selection for "go" state is now handled exclusively by initializeSelectedOs().
        if (window.selected && window.selected !== "go" && !OS_OPTIONS.some(opt => opt.code === window.selected)) {
            window.selected = getRandomAutoSpawnOSCode();
            selected = window.selected; 
        }
        // After populating, update the hot page indicator with project title
        updateHotPageIndicator();
      }

      function getRandomAutoSpawnOSCode() {
        const valid = OS_OPTIONS.filter(o => {
          const cfg = OS_CONFIGS[o.code];
          const notDisabled = !(cfg?.disabled || cfg?.locked || o?.disabled || o?.locked);
          // Only non-private and online VMs
          const nonPrivate = !o.isPrivate && !cfg?.isPrivate;
          const online = (o.isOnline === true) || (cfg?.isOnline === true);
          return o.isConnectable === true && notDisabled && nonPrivate && online;
        });
        if (!valid.length) return (OS_OPTIONS[0]?.code || "");
        return valid[Math.floor(Math.random() * valid.length)].code;
      }

      // On load, select a code via random auto spawn or URL path, store in selected
      function initializeSelectedOs() {
        // 1. Check if current URL path matches any VM
        const currentPath = window.location.pathname;
        const matchingVM = OS_OPTIONS.find(opt => {
            const vmPath = '/' + opt.code;
            // Match exactly /code or ending with /code (to handle project path prefix)
            return currentPath === vmPath || currentPath.endsWith(vmPath);
        });

        if (matchingVM) {
            selected = matchingVM.code;
            console.log(`Auto-selected VM from URL path: ${selected}`);
        } else {
            // 2. Fallback to preference/random if no URL match or previous selection is invalid
            const spawnPref = localStorage.getItem('websim_spawn_pref') || 'random';
            const isCurrentlyValid = OS_OPTIONS.some(opt => opt.code === selected);
            
            if (!isCurrentlyValid || selected === "go") {
                if (spawnPref === 'default') {
                    // Hardcoded default is code '10' (Win 10), otherwise fallback to random
                    const defCode = '10';
                    if (OS_OPTIONS.some(o => o.code === defCode)) {
                        selected = defCode;
                    } else {
                        selected = getRandomAutoSpawnOSCode();
                    }
                } else {
                    selected = getRandomAutoSpawnOSCode();
                }
            }
        }
        // Synchronize window.selected and local selected
        window.selected = selected;
      }

      // State for VM browser filters
      window.vmBrowserFilters = window.vmBrowserFilters || {
          search: '',
          onlineOnly: false,
          embedsOnly: false,
          vncOnly: false,
          lockedOnly: false
      };

      function showOsSwitcher() {
        const selectedOSCode = selected;
        let osSwitcher = document.getElementById("osSwitcherContainer");
        if (!osSwitcher) {
            osSwitcher = document.createElement("div");
            osSwitcher.id = "osSwitcherContainer";
            document.body.appendChild(osSwitcher);
        }

        // Preserve current search/filter elements if they exist to avoid resetting focus
        let filterBar = osSwitcher.querySelector('.vm-browser-filter-bar');
        if (!filterBar) {
            osSwitcher.innerHTML = '';
            
            // Mobile Close Button
            const closeBtn = document.createElement('button');
            closeBtn.className = 'custom-popup-btn secondary os-switch-close-mobile';
            closeBtn.style.display = 'none';
            closeBtn.textContent = 'Close VM List';
            closeBtn.onclick = () => closeOsSwitcher();
            osSwitcher.appendChild(closeBtn);

            const title = document.createElement("div");
            title.id = "osSwitcherTitle";
            title.textContent = "VM BROWSER";
            osSwitcher.appendChild(title);

            // Create Filter Bar
            filterBar = document.createElement('div');
            filterBar.className = 'vm-browser-filter-bar';
            filterBar.style.cssText = `
                display: flex;
                flex-direction: column;
                gap: 12px;
                margin-bottom: 20px;
                background: rgba(255,255,255,0.03);
                padding: 15px;
                border-radius: 12px;
                border: 1px solid rgba(120,150,200,0.15);
            `;

            const searchInput = document.createElement('input');
            searchInput.type = 'text';
            searchInput.className = 'theme-search-input';
            searchInput.placeholder = 'Search VMs by name or description...';
            searchInput.value = window.vmBrowserFilters.search;
            searchInput.style.fontSize = '14px';
            searchInput.style.padding = '10px 14px';
            searchInput.oninput = (e) => {
                window.vmBrowserFilters.search = e.target.value;
                renderOsSwitcherContent();
            };
            filterBar.appendChild(searchInput);

            const filterOptions = document.createElement('div');
            filterBar.appendChild(filterOptions);
            filterOptions.style.cssText = `
                display: flex;
                flex-wrap: wrap;
                gap: 8px;
            `;

            const createFilterToggle = (label, key) => {
                const btn = document.createElement('button');
                btn.className = 'custom-popup-btn secondary';
                btn.style.fontSize = '12px';
                btn.style.padding = '6px 12px';
                btn.textContent = label;
                if (window.vmBrowserFilters[key]) btn.classList.add('primary'), btn.classList.remove('secondary');
                
                btn.onclick = () => {
                    window.vmBrowserFilters[key] = !window.vmBrowserFilters[key];
                    if (window.vmBrowserFilters[key]) {
                        btn.classList.add('primary');
                        btn.classList.remove('secondary');
                    } else {
                        btn.classList.remove('primary');
                        btn.classList.add('secondary');
                    }
                    renderOsSwitcherContent();
                };
                return btn;
            };

            filterOptions.appendChild(createFilterToggle('🟢 Online', 'onlineOnly'));
            filterOptions.appendChild(createFilterToggle('🖼️ Embeds', 'embedsOnly'));
            filterOptions.appendChild(createFilterToggle('📺 VNC', 'vncOnly'));
            filterOptions.appendChild(createFilterToggle('🔒 Locked', 'lockedOnly'));

            osSwitcher.appendChild(filterBar);

            // Container for the categorized VM list
            const contentContainer = document.createElement('div');
            contentContainer.id = 'osSwitcherContent';
            osSwitcher.appendChild(contentContainer);

            const creditsDiv = document.createElement("div");
            creditsDiv.id = "logo-event-credits";
            creditsDiv.textContent = "Logo Event 1st Place: @akrensystem";
            osSwitcher.appendChild(creditsDiv);
        }

        renderOsSwitcherContent();
        updateOsSwitcherToggleText();

        if (window.multiplayerCursors) {
            window.multiplayerCursors.updateOsSwitcherButtonsWithCounts();
        }
      }

      function renderOsSwitcherContent() {
        const contentContainer = document.getElementById('osSwitcherContent');
        if (!contentContainer) return;
        contentContainer.innerHTML = '';

        const filters = window.vmBrowserFilters;
        const searchQuery = filters.search.toLowerCase().trim();
        const selectedOSCode = selected;

        let isPortMod = false;
        try {
          // Use live auth state from multiplayerCursors if available, fallback to localStorage
          const modAuth = window.multiplayerCursors?.moderatorAuth || JSON.parse(localStorage.getItem('moderator_auth_v1'));
          // Broad check: any moderator can see hidden VMs and access mod UI elements
          isPortMod = (modAuth && modAuth.username) || window.multiplayerCursors?.currentUserIsModerator;
        } catch (e) {}

        let visibleCount = 0;

        MAIN_CATEGORY_ORDER.forEach(categoryName => {
            const categoryData = OS_CATEGORIZED[categoryName];
            if (!categoryData || Object.keys(categoryData).length === 0) return;

            let categoryHasVisibleVms = false;
            const categoryEl = document.createElement('div');

            const subcategories = Object.keys(categoryData).sort((a,b) => {
                if (a === 'default') return 1;
                if (b === 'default') return -1;
                return a.localeCompare(b);
            });

            subcategories.forEach(subCategoryName => {
                const vms = categoryData[subCategoryName];
                
                const filteredVms = vms.filter(vm => {
                    // Search
                    if (searchQuery && !vm.name.toLowerCase().includes(searchQuery) && !vm.description.toLowerCase().includes(searchQuery)) return false;
                    // Toggles
                    if (filters.onlineOnly && !vm.isOnline) return false;
                    if (filters.embedsOnly && !vm.isEmbed) return false;
                    if (filters.vncOnly && vm.isEmbed) return false;
                    if (filters.lockedOnly && !vm.isManualPassword) return false;
                    return true;
                });

                if (filteredVms.length === 0) return;

                categoryHasVisibleVms = true;

                if (subCategoryName !== 'default') {
                    const subCategoryHeader = document.createElement('h3');
                    subCategoryHeader.className = 'subcategory-header';
                    subCategoryHeader.textContent = subCategoryName;
                    categoryEl.appendChild(subCategoryHeader);
                }

                const btnRow = document.createElement("div");
                btnRow.className = "osSwitcherBtnRow";

                const sortedVms = [...filteredVms].sort((a, b) => (b.isSponsored === true) - (a.isSponsored === true));

                sortedVms.forEach((vmData) => {
                  visibleCount++;
                  const { name, code, label, icon, isConnectable, isEmbed, description, screenshot, isManualPassword, alwaysReadRules, rulesTimeout, isPrivate, isOnline, isBlacklisted, blacklistReason, isSponsored } = vmData;
                  const btn = document.createElement("button");
                  btn.className = "os-switch-btn";
                  if (isSponsored) btn.classList.add('sponsored-vm');
                  if (vmData.hidden) btn.classList.add('vm-hidden');
                  
                  const sLabel = sanitize(label);
                  const safeDesc = (description || '').trim();
                  const truncated = sanitize(safeDesc.length > 240 ? (safeDesc.slice(0, 237) + '…') : (safeDesc || 'No description'));
                  const sIcon = sanitize(icon);
                  const sScreenshot = sanitize(screenshot);

                  const shotHtml = sScreenshot ? `<img class="vm-shot" src="${sScreenshot}" alt="screenshot for ${sLabel}" loading="lazy"/>` : '';
                  const lockHtml = isManualPassword ? ` <span title="Manual password required" aria-label="Manual Password" style="margin-left:6px;">🔒</span>` : '';

                  btn.innerHTML = `<img class='os-icon' src="${sIcon}" loading="lazy" alt='${sLabel}'/>
                                   <div class="vm-info-group">
                                       <div class="vm-label">${sLabel}${lockHtml}</div>
                                       <div class="vm-desc">${truncated}</div>
                                   </div>${shotHtml}`;
                  btn.setAttribute("data-oscode", code);
                  if(code === selectedOSCode) btn.setAttribute("aria-current", "true");
                  if (isConnectable === false) btn.classList.add('os-btn-unavailable');

                  btn.addEventListener("click", async (event) => {
                    if (event.target.closest('.vm-mod-dots') || event.target.closest('.vm-mod-dropdown')) return;
                    const forceRules = event.shiftKey;
                    // If already on this VM and not forcing rules, just close switcher
                    if (code === window.selected && !forceRules) {
                        closeOsSwitcher();
                        return;
                    }
                    // enterVm will handle the logic and only call switchOS (updating state) on success
                    await enterVm(code, forceRules);
                    closeOsSwitcher();
                  });

                  const isOwner = vmData.extras && vmData.extras.selfHostOwner === window.multiplayerCursors?.currentUserId;
                  
                  if (vmData.extras && vmData.extras.selfHostOwner && vmData.extras.selfHostDeleteIn) {
                      const delTimer = document.createElement('div');
                      delTimer.className = 'self-host-timer';
                      delTimer.style.cssText = 'position:absolute; bottom:8px; left:42px; font-size:9px; color:#ffb4a8; font-weight:bold; background:rgba(0,0,0,0.7); padding:2px 5px; border-radius:4px; z-index:11; border:1px solid rgba(255,100,100,0.3);';
                      
                      const updateTimer = () => {
                          const remain = vmData.extras.selfHostDeleteIn - Date.now();
                          if (remain <= 0) {
                              delTimer.textContent = 'DELETING NOW...';
                          } else {
                              const hours = Math.floor(remain / 3600000);
                              const mins = Math.floor((remain % 3600000) / 60000);
                              delTimer.textContent = `DELETES IN ${hours}h ${mins}m`;
                          }
                      };
                      updateTimer();
                      const interval = setInterval(() => {
                          if (!document.body.contains(delTimer)) return clearInterval(interval);
                          updateTimer();
                      }, 30000);
                      btn.appendChild(delTimer);
                  }

                  if (isOwner || isPortMod) {
                    const dots = document.createElement('div');
                    dots.className = 'vm-mod-dots';
                    dots.textContent = '...';
                    dots.onclick = async (e) => {
                        e.stopPropagation();
                        const dd = dots.nextSibling;
                        document.querySelectorAll('.vm-mod-dropdown.active').forEach(d => { if (d !== dd) d.classList.remove('active'); });
                        dd.classList.toggle('active');
                        if (dd.classList.contains('active') && window.multiplayerCursors) window.multiplayerCursors.refreshModeratorData();
                    };
                    
                    const dropdown = document.createElement('div');
                    dropdown.className = 'vm-mod-dropdown';
                    
                    const actions = [];
                    
                    if (isOwner) {
                        actions.push({ 
                            label: 'Renew VM', 
                            handler: async () => {
                                try {
                                    const payload = { renew: true, path: '/' + code };
                                    const params = new URLSearchParams();
                                    for (const [key, val] of Object.entries(payload)) {
                                        params.append(key, typeof val === 'object' ? JSON.stringify(val) : val);
                                    }
                                    const url = window.apiSegment + '/selfhosted?' + params.toString();
                                    const response = await fetch(url);
                                    if (!response.ok) {
                                        const txt = await response.text();
                                        if (response.status === 429) throw new Error("Renewal cooldown active.");
                                        if (response.status === 403) throw new Error("Permission denied or VM offline.");
                                        throw new Error(txt || "Renewal failed.");
                                    }
                                    showNotification("VM Renewed!", "success");
                                    refreshVMList();
                                } catch (err) {
                                    showNotification(err.message, "error");
                                }
                            }
                        });
                        actions.push({
                            label: 'Edit (Renew)',
                            handler: () => openSelfHostModal(vmData)
                        });
                    }

                    if (isPortMod) {
                        actions.push({ label: vmData.isAdminDisabled ? 'Enable' : 'Disable', action: vmData.isAdminDisabled ? 'enable' : 'disable' });
                        actions.push({ label: 'Edit', action: 'edit' });
                        actions.push({ label: 'Kick All Players', action: 'kickall', danger: true });
                        actions.push({ label: 'Delete', action: 'delete', danger: true });
                    }

                    actions.forEach(act => {
                        const item = document.createElement('div');
                        item.className = 'vm-mod-item' + (act.danger ? ' danger' : '');
                        item.textContent = act.label;
                        item.onclick = (e) => { 
                            e.stopPropagation(); 
                            dropdown.classList.remove('active'); 
                            if (act.handler) act.handler();
                            else if (act.action) handleVmModAction(act.action, vmData);
                        };
                        dropdown.appendChild(item);
                    });

                    btn.appendChild(dots);
                    btn.appendChild(dropdown);
                  }
                  btnRow.appendChild(btn);
                });
                categoryEl.appendChild(btnRow);
            });

            if (categoryHasVisibleVms) {
                const categoryHeader = document.createElement('h2');
                categoryHeader.className = 'category-header';
                categoryHeader.style.fontWeight = 'bold';
                categoryHeader.textContent = categoryName;
                contentContainer.appendChild(categoryHeader);
                contentContainer.appendChild(categoryEl);
            }
        });

        if (visibleCount === 0) {
            contentContainer.innerHTML = `<div style="text-align:center; padding:40px; color:#a0aec0; font-style:italic;">No VMs found matching your current filters.</div>`;
        }

        // Add "+ Add Port Mapping" button for moderators at the bottom of the list
        if (isPortMod) {
            const addPortBtn = document.createElement('button');
            addPortBtn.className = 'custom-popup-btn secondary';
            addPortBtn.style.cssText = 'width: 100%; margin-top: 20px; border-style: dashed; padding: 12px; font-weight: 800; color: #4fd3ff; border-color: rgba(79, 211, 255, 0.4);';
            addPortBtn.textContent = '+ ADD PORT MAPPING';
            addPortBtn.onclick = () => openEditVmModal({ code: 'new' });
            contentContainer.appendChild(addPortBtn);
        }

        if (window.multiplayerCursors) {
            window.multiplayerCursors.updateOsSwitcherButtonsWithCounts();
        }
      }

      function updateOsSwitcherToggleText() {
        const toggleBtn = document.getElementById('os-switcher-toggle');
        if (toggleBtn) {
            const currentOsName = OS_OPTIONS.find(o => o.code === selected)?.label || "Select OS";
            toggleBtn.textContent = `OS: ${currentOsName}`;
        }
      }

      // New helper to centralize VNC connection start
      function startVNCConnection() {
        const config = OS_CONFIGS[window.selected];
        // Check if config is actually loaded
        if (!config) {
            console.error("OS_CONFIGS not loaded for selected OS:", window.selected);
            setStatus("Waiting for VM list to load...");
            setTimeout(startVNCConnection, 500); // Retry if not yet loaded
            return;
        }
        connectVNC(window.selected, config);
      }

      // New function to create the OS switcher toggle button
      function createOsSwitcherToggle() {
        if (document.getElementById('os-switcher-toggle')) return;

        const header = document.getElementById('header-bar');
        if (!header) return;

        const toggleBtn = document.createElement('button');
        toggleBtn.id = 'os-switcher-toggle';
        header.insertBefore(toggleBtn, header.firstChild); // Insert at the beginning of the header

        toggleBtn.addEventListener('click', () => {
          const switcher = document.getElementById('osSwitcherContainer');
          if (switcher) {
            const isActive = switcher.classList.toggle('active');
            const overlay = ensureOverlay();
            if (overlay) {
              overlay.style.display = isActive ? 'block' : 'none';
            }
            if (isActive) {
              // Pause VM list refresh when dropdown is open
              if (typeof stopVmListRefresh === 'function') stopVmListRefresh();
              // Close other panels
              if (window.multiplayerCursors) window.multiplayerCursors.closePlayerList();
              const settingsPanel = document.getElementById('settings-panel');
              if (settingsPanel) settingsPanel.classList.remove('active');
              const themesPanel = document.getElementById('custom-themes-panel');
              if (themesPanel) themesPanel.classList.remove('active');
            } else {
              // Resume refresh when closed
              if (typeof startVmListRefresh === 'function') startVmListRefresh();
            }
          }
        });

        // Initial text update
        updateOsSwitcherToggleText();
      }

      // Reconnect logic (works for both VNC and embed VMs)
      function reconnectCurrent() {
        try {
          const oscode = window.selected;
          const cfg = OS_CONFIGS[oscode];
          if (!cfg) {
            setStatus("No VM config to reconnect");
            return;
          }

          // If it's an embed VM, just reload the iframe (or render if missing)
          if (cfg.isEmbed) {
            const screenElem = document.getElementById("screen");
            const iframe = screenElem.querySelector('iframe');
            const url = cfg.embedUrl + (cfg.embedUrl.includes('?') ? '&' : '?') + 'ts=' + Date.now();
            if (iframe) {
              iframe.src = url;
            } else {
              screenElem.innerHTML = `<iframe src="${url}" style="width:100%;height:100%;border:none;"></iframe>`;
            }
            setStatus("Reloaded embed");
            return;
          }

          // For manual password VMs, ensure we have a password
          if (cfg.isManualPassword && !customPasswords[oscode]) {
            const savedPassword = getVmPassword(oscode);
            if (savedPassword) {
              customPasswords[oscode] = savedPassword;
            } else {
              openManualPasswordModal(oscode, cfg.name || oscode).then(pw => {
                if (pw) {
                  customPasswords[oscode] = pw;
                  setStatus("Reconnecting...");
                  disconnectVNC();
                  setTimeout(() => connectVNC(oscode, cfg), 300);
                }
              });
              return;
            }
          }

          // For VNC-backed VMs, disconnect and reconnect cleanly
          setStatus("Reconnecting...");
          disconnectVNC();
          setTimeout(() => {
            connectVNC(oscode, cfg);
          }, 300);
        } catch (e) {
          console.error('Reconnect failed:', e);
          setStatus("Reconnect failed");
        }
      }

      // New: Hot page indicator update
      async function updateHotPageIndicator() {
        const indicator = document.getElementById('hot-page-indicator');
        if (indicator) {
            indicator.textContent = "";
        }
      }

      function closeOsSwitcher() {
        const switcher = document.getElementById("osSwitcherContainer");
        const overlay = ensureOverlay();
        if (switcher) switcher.classList.remove('active');
        if (overlay) overlay.style.display = 'none';
        startVmListRefresh(); // Restart refresh when closing dropdown programmatically
      }

      // VM-specific rules helpers
      function vmRulesKey(oscode) {
        return `vmRulesAccepted:${oscode}`;
      }
      // NEW: store extended info with timestamp for timeout support
      function vmRulesInfoKey(oscode) {
        return `vmRulesAcceptedInfo:${oscode}`;
      }
      // NEW: parse "1s","1m","1h","1d","1mo","1y" into ms
      function parseRulesTimeoutMs(str) {
        if (!str || typeof str !== 'string') return 0;
        const m = str.trim().toLowerCase().match(/^(\d+)\s*(s|m|h|d|mo|y)$/);
        if (!m) return 0;
        const n = parseInt(m[1], 10);
        const unit = m[2];
        const msMap = {
          s: 1000,
          m: 60 * 1000,
          h: 60 * 60 * 1000,
          d: 24 * 60 * 60 * 1000,
          mo: 30 * 24 * 60 * 60 * 1000,
          y: 365 * 24 * 60 * 60 * 1000
        };
        return (msMap[unit] || 0) * n;
      }

      function hasAcceptedVmRules(oscode) {
        try {
          const cfg = OS_CONFIGS[oscode] || {};
          // If VM wants rules always to be read, force prompt every time
          if (cfg.alwaysReadRules) return false;

          // Check extended info first (with timestamp)
          const infoRaw = localStorage.getItem(vmRulesInfoKey(oscode));
          if (infoRaw) {
            try {
              const info = JSON.parse(infoRaw);
              const acceptedAt = Number(info.acceptedAt || 0);
              if (acceptedAt > 0) {
                const timeoutMs = parseRulesTimeoutMs(cfg.rulesTimeout);
                if (timeoutMs > 0) {
                  return Date.now() - acceptedAt < timeoutMs;
                }
                // No timeout configured => acceptance persists
                return true;
              }
            } catch (_) {
              // fall through to legacy boolean key
            }
          }

          // Backward compatibility: plain boolean flag
          return localStorage.getItem(vmRulesKey(oscode)) === 'true';
        } catch { return false; }
      }
      function markAcceptedVmRules(oscode) {
        try {
          // Backward compatibility flag
          localStorage.setItem(vmRulesKey(oscode), 'true');
          // Extended info with timestamp for timeout support
          const info = { acceptedAt: Date.now() };
          localStorage.setItem(vmRulesInfoKey(oscode), JSON.stringify(info));
        } catch {}
      }

      function findAlternativeVm(excludeCode) {
        // Prefer VMs without rules or whose rules are already accepted
        const candidates = AUTO_SPAWN_POOL.filter(c => c !== excludeCode);
        const preferred = candidates.filter(c => {
          const cfg = OS_CONFIGS[c];
          const rules = cfg?.rules || [];
          // If alwaysReadRules, they'll always be prompted; prefer ones without rules or already accepted AND not forcing always read
          if (cfg?.alwaysReadRules) return rules.length === 0;
          return rules.length === 0 || hasAcceptedVmRules(c);
        });
        const pool = preferred.length ? preferred : candidates;
        if (!pool.length) return null;
        return pool[Math.floor(Math.random() * pool.length)];
      }

      function openVmRulesModal(oscode) {
        // Automatically close OS Switcher when entering Rules screen
        closeOsSwitcher();

        const cfg = OS_CONFIGS[oscode];
        const overlay = document.getElementById('vm-rules-overlay');
        const modal = document.getElementById('vm-rules-modal');
        const titleEl = document.getElementById('vm-rules-title');
        const nameEl = modal.querySelector('.vm-name');
        const descEl = modal.querySelector('.vm-rules-desc');
        const listEl = modal.querySelector('.vm-rules-list');
        const thumbnailEl = document.getElementById('vm-rules-thumbnail');
        const playersSection = document.getElementById('vm-rules-players-section');
        const playersList = document.getElementById('vm-rules-players-list');
        const promptEl = document.getElementById('vm-rules-prompt');
        const controlsSection = document.getElementById('vm-rules-controls-section');
        const controlsList = document.getElementById('vm-rules-controls-list');
        
        const hasRules = cfg.rules && cfg.rules.length > 0;
        const needsAgreement = hasRules || cfg.alwaysReadRules || cfg.prompt;

        // Update modal content
        titleEl.textContent = needsAgreement ? "VM Rules & Info" : "Enter VM";
        nameEl.textContent = `VM: ${cfg?.name || oscode}`;
        descEl.textContent = (cfg?.description || '').trim();
        
        // Handle custom prompt
        if (cfg.prompt) {
            promptEl.textContent = cfg.prompt;
            promptEl.style.display = 'block';
        } else {
            promptEl.style.display = 'none';
        }

        // Show/hide rules list
        listEl.innerHTML = '';
        if (hasRules) {
            listEl.style.display = 'block';
            (cfg?.rules || []).forEach(rule => {
                const li = document.createElement('li');
                li.textContent = rule;
                listEl.appendChild(li);
            });
        } else {
            listEl.style.display = 'none';
        }

        // Always show thumbnail and players
        thumbnailEl.src = cfg.screenshot || '';
        thumbnailEl.style.display = 'block';
        playersSection.style.display = 'block';
        playersList.innerHTML = '<li>Loading...</li>';

        // Render VM Controls
        const controls = cfg.extras?.controls || {};
        const controlKeys = Object.keys(controls);
        if (controlKeys.length > 0) {
            controlsSection.style.display = 'block';
            controlsList.innerHTML = '';
            controlKeys.forEach(key => {
                const ctrl = controls[key];
                if (ctrl.type === 'button') {
                    const btn = document.createElement('button');
                    btn.className = 'custom-popup-btn secondary';
                    btn.style.fontSize = '11px';
                    btn.style.padding = '6px 10px';
                    btn.textContent = ctrl.name || key;
                    btn.onclick = () => {
                        if (window.multiplayerCursors) {
                            window.multiplayerCursors.handleVmControl(oscode, key, ctrl);
                        }
                    };
                    controlsList.appendChild(btn);
                }
            });
            
            // Initial call to check for active votes to render UI immediately
            if (window.multiplayerCursors) {
                window.multiplayerCursors.refreshVoteUI(oscode);
            }
        } else {
            controlsSection.style.display = 'none';
        }

        // Populate player list
        if (window.multiplayerCursors && window.multiplayerCursors.osPlayers) {
            const players = window.multiplayerCursors.osPlayers[oscode] || [];
            if (players.length > 0) {
                playersList.innerHTML = '';
                players.forEach(p => {
                    const li = document.createElement('li');
                    li.textContent = p.username;
                    playersList.appendChild(li);
                });
            } else {
                playersList.innerHTML = '<li>No one is here yet.</li>';
            }
        } else {
            playersList.innerHTML = '<li>Player list unavailable.</li>';
        }

        const agreeBtn = document.getElementById('vm-rules-agree');
        const declineBtn = document.getElementById('vm-rules-decline');

        // Update button text
        agreeBtn.textContent = needsAgreement ? "Agree & Enter" : "Continue";
        declineBtn.textContent = needsAgreement ? "Decline" : "Nvm I don't wanna go here";

        // Clean previous handlers
        agreeBtn.onclick = null; declineBtn.onclick = null;

        return new Promise((resolve) => {
          agreeBtn.onclick = async () => {
            markAcceptedVmRules(oscode);
            overlay.style.display = 'none';
            modal.style.display = 'none';
            resolve(true);
          };
          declineBtn.onclick = async () => {
            overlay.style.display = 'none';
            modal.style.display = 'none';
            resolve(false);
          };
          overlay.style.display = 'flex';
          modal.style.display = 'block';
        });
      }

      async function ensureVmRules(oscode, forceShow = false) {
        const cfg = OS_CONFIGS[oscode];
        const rules = cfg?.rules || [];
        const hasRules = rules.length > 0;
        const needsAgreement = hasRules || cfg.alwaysReadRules || cfg.prompt;

        // Show prompt if:
        // 1. alwaysReadRules is enabled.
        // 2. The user has not accepted the rules/prompt for this VM, or their acceptance has expired.
        // 3. forceShow is true (for shift-click)
        // 4. There are no rules but there's a prompt they haven't seen/agreed to.
        if (forceShow || cfg?.alwaysReadRules || !hasAcceptedVmRules(oscode)) {
            const accepted = await openVmRulesModal(oscode);
            if (accepted) return true;

            // Declined:
            // if agreement was required, potentially switch VMs. Otherwise, just cancel.
            if (needsAgreement) {
                const alt = findAlternativeVm(oscode);
                if (alt) {
                    // Do not update selected here, let enterVm -> switchOS handle it
                    await enterVm(alt);
                } else {
                    setStatus("No alternative VM available.");
                }
            }
            return false;
        }

        // Already accepted rules and not forced to re-read
        return true;
      }

      async function enterVm(oscode, forceRules = false) {
        // Check blacklist first
        const canAccess = await checkVmBlacklist(oscode);
        if (!canAccess) return;

        // Enforce VM-specific rules agreement before entering
        const ok = await ensureVmRules(oscode, forceRules);
        if (!ok) return;
        await switchOS(oscode);
      }

      function updateRetypePasswordButtonVisibility(oscode) {
        const btn = document.getElementById('retype-password-btn');
        if (!btn) return;

        const config = OS_CONFIGS[oscode];
        if (config && config.isManualPassword) {
          btn.classList.add('visible');
        } else {
          btn.classList.remove('visible');
        }
      }

      let osSwitchInProgress = false;

      // Switching setup: always port 443, just change vncPath
      async function switchOS(oscode) {
        // Check blacklist first
        const canAccess = await checkVmBlacklist(oscode);
        if (!canAccess) return;

        const config = OS_CONFIGS[oscode];
        if (!config) {
          if (window.showNotification) window.showNotification("Unknown/unsupported OS!", "error");
          return;
        }

        // Handle embed-only VMs by embedding their URL instead of VNC
        if (config.isEmbed) {
          const screenElem = document.getElementById("screen");
          screenElem.innerHTML =
            `<iframe src="${config.embedUrl}" style="width:100%;height:100%;border:none;"></iframe>`;
          
          // CRITICAL: Update source of truth only when connection actually switches
          window.selected = selected = oscode;
          
          updateOsSwitcherToggleText();
          updateRetypePasswordButtonVisibility(oscode);
          closeOsSwitcher();
          return;
        }

        const screenElem = document.getElementById("screen");
        screenElem.innerHTML = '';

        if (osSwitchInProgress) return;
        osSwitchInProgress = true;

        // CRITICAL: Update source of truth only when connection actually switches
        window.selected = selected = oscode;

        const configNormal = OS_CONFIGS[oscode];

        if (configNormal.isManualPassword && !customPasswords[oscode]) {
            const savedPassword = getVmPassword(oscode);
            if (savedPassword) {
              customPasswords[oscode] = savedPassword;
            } else {
              const osOption = OS_OPTIONS.find(o => o.code === oscode);
              const osName = osOption ? osOption.name : oscode;
              const pw = await openManualPasswordModal(oscode, osName);
              if (!pw) {
                  setStatus("Password not entered. Aborting connect.");
                  osSwitchInProgress = false;
                  return;
              }
              customPasswords[oscode] = pw;
              // Saving is handled inside openManualPasswordModal
            }
        }
        
        disconnectVNC();
        setTimeout(() => {
          connectVNC(oscode, configNormal);
          showOsSwitcher();
          updateOsSwitcherToggleText();
          updateRetypePasswordButtonVisibility(oscode);
          osSwitchInProgress = false;
          window.selected = selected = oscode;

          if (window.multiplayerCursors) {
              window.multiplayerCursors.updateOsSwitcherButtonsWithCounts();
          }

        }, 1000);
      }

      function disconnectVNC() {
        if (window.rfb && typeof window.rfb.disconnect === 'function') {
          try { window.rfb.disconnect(); } catch (e) { }
        } else if (window.rfb && typeof window.rfb.close === 'function') {
          try { window.rfb.close(); } catch (e) { }
        }
        window.rfb = null;
        rfb = null;
      }

      function isBanned() {
        return readQueryVariable("version", "") === "ban" || window.__specialState === '/ThisPersonIsBanned';
      }

      function showBannedMessage() {
        let banMessage = "socket closed: You're banned from this project";
        
        if (window.__specialState === '/ThisPersonIsBanned' && window.__specialData) {
            const data = window.__specialData;
            const reason = data.reason || "Unknown reason";
            const expiry = data.bannedUntil ? 'until: ' + new Date(data.bannedUntil).toLocaleString() : 'forever';
            banMessage = `You are banned for reason: ${reason}. Mistake? Contact e1x8 via Discord! Have fun in Windows ME! Banned ${expiry}`;
        }

        setStatus("BANNED");
        // Optionally, disable UI elements
        const header = document.getElementById("header-bar");
        if (header) {
            header.style.pointerEvents = 'none';
            header.style.opacity = '0.5';
        }
        document.getElementById("screen").innerHTML = `
            <div style='font-family:sans-serif;color:#ff6b6b;text-align:center;padding:20px;margin-top:5em;background:rgba(0,0,0,0.8);border:2px solid #ff6b6b;border-radius:12px;max-width:80%;margin-left:auto;margin-right:auto;box-shadow:0 0 30px rgba(255,107,107,0.2);'>
                <div style="font-size:2.5em;font-weight:800;margin-bottom:0.5em;text-transform:uppercase;">Access Denied</div>
                <div style="font-size:1.2em;line-height:1.5;white-space:pre-wrap;">${banMessage}</div>
            </div>`;
      }

      // PORT IS 443. Use config from selected variable.
      async function connectVNC(oscode, config) {
        // Check blacklist before connecting
        const canAccess = await checkVmBlacklist(oscode);
        if (!canAccess) return;

        if (isBanned()) {
          showBannedMessage();
          return;
        }

        const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        let url = `${wsProtocol}//${window.location.host}${window.apiSegment}${config.path}`;
        let separator = url.includes('?') ? '&' : '?';

        // Determine password to use
        let password = config.password;
        if (config.isManualPassword && customPasswords[selected]) {
          password = customPasswords[selected];
        }

        // If password is set, add to query string
        if (password) {
            url += separator + "password=" + encodeURIComponent(password);
            separator = '&';
        }

        url += separator + "origin=" + encodeURIComponent(window.location.href);
        separator = '&';

        try {
          const user = await window.websim.getCurrentUser();
          if (user && user.username) {
              url += separator + "username=" + encodeURIComponent(user.username);
          }
        } catch (e) {
          console.warn("Could not get username for query:", e);
        }

        try {
          const screenElem = document.getElementById("screen");
          if (screenElem) screenElem.innerHTML = '';
          const RFB_Class = (typeof RFB === 'function') ? RFB : (RFB.default || RFB);
          window.rfb = rfb = new RFB_Class(screenElem, url, {
            credentials: { password: password },
            wsProtocols: ['binary']
          });
          rfb.addEventListener("connect", connectedToServer);
          rfb.addEventListener("disconnect", disconnectedFromServer);
          rfb.addEventListener("credentialsrequired", credentialsAreRequired);
          rfb.addEventListener("desktopname", updateDesktopName);
          rfb.addEventListener("clipboard", handleClipboardFromServer);
          rfb.scaleViewport = true;
          rfb.resizeSession = false;
          
          reconnectCountdown = 0;
          if (reconnectTimer) { clearTimeout(reconnectTimer); }
          reconnectTimer = null;
          setStatus("Connecting to VM...");
        } catch (e) {
          setStatus("Failed to connect to selected OS.");
          console.error("VNC Connect Error:", e);
        }
      }

      // Helper: defensive validation of the VM list payload
      function validateVmList(vms) {
        // Expecting an object with VM path keys; if array or null/undefined, treat as invalid
        if (!vms || typeof vms !== 'object') return false;
        // At least one key with object value
        return Object.values(vms).some(val => val && typeof val === 'object');
      }

      // Helper: fetch with timeout
      async function fetchWithTimeout(url, opts = {}, timeoutMs = 5000) {
        const controller = new AbortController();
        const t = setTimeout(() => controller.abort(), timeoutMs);
        try {
          const res = await fetch(url, {...opts, signal: controller.signal});
          return res;
        } finally {
          clearTimeout(t);
        }
      }

      const screenshotState = new Map(); // code -> { loading: boolean, lastUrl: string, error: boolean }

      // Function to refresh VM list (called periodically)
      async function refreshVMList() {
        if (window.__emergencyMode) return;
        try {
          let listUrl = window.apiSegment + '/list';
          
          const response = await fetchWithTimeout(listUrl, {}, 6000);
          if (response.status === 523) {
            enterEmergencyMode();
            return;
          }
          if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
          }

          let vms;
          try {
            vms = await response.json();
          } catch (err) {
            throw new Error('Invalid JSON returned by list');
          }

          if (!validateVmList(vms)) {
            throw new Error('List payload invalid/empty');
          }

          populateOsData(vms);
          window.dispatchEvent(new CustomEvent('vm-list-updated'));
          // Only update the switcher's content, don't fully re-render if it's open,
          // to preserve scroll position and screenshot states visually.
          const osSwitcherContainer = document.getElementById('osSwitcherContainer');
          if (osSwitcherContainer && !osSwitcherContainer.classList.contains('active')) {
              showOsSwitcher();
          } else if (osSwitcherContainer && window.multiplayerCursors) {
              // If it's open, just update player counts
              window.multiplayerCursors.updateOsSwitcherButtonsWithCounts();
          }
          updateOsSwitcherToggleText();

          ensureOverlay(); // make sure overlay exists now

          // mark that we've successfully loaded at least once
          window.__vmListHadSuccess = true;

          // Hide list error overlay on successful refresh
          const overlay = document.getElementById('listErrorOverlay');
          if (overlay && overlay.style) { overlay.style.display = 'none'; }

        } catch (error) {
          console.error("Failed to refresh VM list:", error);
          // If we've already had at least one successful load, don't spam the big error overlay
          if (window.__vmListHadSuccess) {
            // Soft fail: do not interrupt UI
            return;
          }
          // Show a non-blocking overlay error but keep chat and player list interactive
          showListErrorOverlay(error.message || 'Failed to refresh VM list');
        }
      }

      // Helper to show error overlay when VM list cannot be loaded
      function showListErrorOverlay(msg) {
        // Guard against very early calls
        if (!document || !document.body) return;
        let overlay = document.getElementById('listErrorOverlay');
        if (!overlay) {
          try {
            overlay = document.createElement('div');
            overlay.id = 'listErrorOverlay';
            overlay.style.position = 'fixed';
            overlay.style.top = '64px';
            overlay.style.right = '16px';
            overlay.style.zIndex = '2600';
            overlay.style.maxWidth = '360px';
            overlay.style.pointerEvents = 'none';
            document.body.appendChild(overlay);
          } catch (e) {
            console.warn('Could not create error overlay:', e);
            return;
          }
        }
        overlay.innerHTML = `
          <div class="errorBox" style="
            pointer-events:auto;
            background: linear-gradient(180deg, rgba(34, 17, 17, 0.95), rgba(24, 12, 12, 0.95));
            color: #ffd9d3;
            border: 1px solid rgba(255,120,120,0.25);
            border-radius: 10px;
            box-shadow: 0 12px 28px rgba(0,0,0,.45);
            padding: 12px 14px;
            font-family: inherit;
          ">
            <h2 style="margin:0 0 6px 0;font-size:14px;color:#ffb4a8;">Failed to load VM list</h2>
            <p style="margin:0 0 6px 0;font-size:12px;color:#ffd9d3;">${(msg||'Unknown error')}</p>
            <p style="margin:0;font-size:12px;">
              Try again later or
              <a href="https://discord.gg/hBwz45hq4z" target="_blank" rel="noopener noreferrer" style="color:#ffe3df;text-decoration:underline;">join our Discord</a>
              for updates.
            </p>
          </div>`;
        if (overlay && overlay.style) {
          overlay.style.display = 'block';
        }
      }

      // New function to fetch VM list initially and set up UI
      async function fetchVMListAndInitialize() {
        try {
          let listUrl = window.apiSegment + '/list';

          const response = await fetchWithTimeout(listUrl, {}, 8000);
          if (response.status === 523) {
            enterEmergencyMode();
            return;
          }
          if (!response.ok) {
            throw new Error(`HTTP error! status: ${response.status}`);
          }
          let vms;
          try {
            vms = await response.json();
          } catch (err) {
            throw new Error('Invalid JSON returned by list');
          }

          if (!validateVmList(vms)) {
            throw new Error('List payload invalid/empty');
          }

          // Hide list error overlay after successful initial fetch
          const initOverlay = document.getElementById('listErrorOverlay');
          if (initOverlay && initOverlay.style) { initOverlay.style.display = 'none'; }

          populateOsData(vms);

          // mark that we've successfully loaded at least once
          window.__vmListHadSuccess = true;

          // Now that OS_OPTIONS and OS_CONFIGS are populated, proceed with initialization
          initializeSelectedOs(); // This will pick a random OS from the new pool if needed
          createOsSwitcherToggle();

          const header = document.getElementById('header-bar');
          
          showOsSwitcher(); // Create the switcher panel (initially hidden)
          // Begin periodic refresh of screenshots in the OS switcher
          startScreenshotRefresh();

          ensureOverlay(); // make sure overlay exists now

          // Global Rules first
          const rulesAccepted = localStorage.getItem('websimRulessAccepted');
          if (rulesAccepted === 'true') {
              // VM-specific rules then enter
              await enterVm(window.selected);
          } else {
              showRulesModal();
          }
          
          if (window.multiplayerCursors) {
              window.multiplayerCursors.updateOsSwitcherButtonsWithCounts();
          }
          
          // Setup the getter/setter for window.selected after initial OS selection
          if (!window._selected_getter_setter_applied) {
            let _selected_val = selected; // Use the local 'selected' from initializeSelectedOs
            Object.defineProperty(window, "selected", {
              get: () => _selected_val,
              set: (v) => {
                if (_selected_val !== v) {
                  _selected_val = v;
                  selected = v; // Keep local 'selected' in sync
                  window.dispatchEvent(new CustomEvent('selected-os-changed', { detail: { selected: v }}));
                }
              },
              configurable: true
            });
            window._selected_getter_setter_applied = true;
          }

          startVmListRefresh(); // Start periodic refresh after initial load

        } catch (error) {
          if (window.__emergencyMode) return;
          console.error("Failed to fetch VM list:", error);
          // Only show overlay if we haven't ever succeeded (prevent noisy overlay later)
          if (!window.__vmListHadSuccess) {
            showListErrorOverlay(error.message || 'Unknown error');
          }
          // Retry fetching the list after a short delay
          setTimeout(fetchVMListAndInitialize, 3000);
          return;
        }
      }

      let vmListRefreshIntervalId = null;

      // Expose for external calls (e.g. from moderator panel or multiplayer-cursors)
      window.refreshVMList = refreshVMList;

      function startVmListRefresh() {
          if (vmListRefreshIntervalId) {
              clearInterval(vmListRefreshIntervalId);
          }
          vmListRefreshIntervalId = setInterval(() => {
              const osSwitcherContainer = document.getElementById('osSwitcherContainer');
              if (osSwitcherContainer && osSwitcherContainer.classList.contains('active')) {
                  // Dropdown is open, do not refresh
                  // console.log("OS Switcher open, skipping VM list refresh.");
              } else {
                  // Dropdown is closed, refresh
                  refreshVMList();
              }
          }, 2000); // Every 2 seconds
          console.log("Started VM list refresh interval.");
      }

      function stopVmListRefresh() {
          if (vmListRefreshIntervalId) {
              clearInterval(vmListRefreshIntervalId);
              vmListRefreshIntervalId = null;
              console.log("Stopped VM list refresh interval.");
          }
      }

      async function enterEmergencyMode() {
        if (window.__emergencyMode) return;
        window.__emergencyMode = true;

        console.warn("SERVER UNREACHABLE (523). Entering Emergency Mode.");
        
        // Stop all intervals
        if (vmListRefreshIntervalId) clearInterval(vmListRefreshIntervalId);
        if (screenshotRefreshIntervalId) clearInterval(screenshotRefreshIntervalId);
        
        disconnectVNC();

        // Modshare Emergency Mode: if modshare-button exists, just stop the VM refresh and stay
        if (document.getElementById('modshare-button')) {
            console.log("Modshare detected. Entering silent emergency mode.");
            // We disconnected from VNC servers above, but keep WebsimSocket alive.
            return;
        }

        // Helper to check if mobile
        const isTouchDevice = 'ontouchstart' in window || navigator.maxTouchPoints > 0;

        // Clear page and apply minimal styles
        document.body.innerHTML = `
          <style>
            #em-chat-messages::-webkit-scrollbar { width: 6px; }
            #em-chat-messages::-webkit-scrollbar-thumb { background: #334155; border-radius: 3px; }
            .em-msg { animation: emFadeIn 0.2s ease-out; }
            @keyframes emFadeIn { from { opacity: 0; transform: translateY(5px); } to { opacity: 1; transform: translateY(0); } }
            .em-cursor {
              position: fixed;
              pointer-events: none;
              z-index: 1000000;
              transition: transform 0.1s linear, opacity 0.3s ease;
              display: flex;
              flex-direction: column;
              align-items: center;
              gap: 4px;
            }
            .em-cursor-label {
              background: rgba(0,0,0,0.6);
              color: white;
              padding: 2px 6px;
              border-radius: 4px;
              font-size: 10px;
              font-weight: bold;
              white-space: nowrap;
              backdrop-filter: blur(2px);
            }
            .em-cursor-icon {
              width: 16px;
              height: 16px;
              filter: drop-shadow(0 2px 4px rgba(0,0,0,0.5));
            }
            /* Circle cursor for mobile/touch */
            .em-cursor-circle {
              width: 32px;
              height: 32px;
              border: 2px solid white;
              border-radius: 50%;
              background: rgba(255,255,255,0.2);
              box-shadow: 0 0 10px rgba(255,255,255,0.3);
            }
          </style>
          <div id="emergency-overlay" style="position:fixed; inset:0; background:#0f172a; color:#f1f5f9; display:flex; flex-direction:column; font-family: -apple-system, system-ui, sans-serif; overflow:hidden; z-index:999999;">
            <div id="emergency-header" style="background:#1e293b; padding:24px; border-bottom:1px solid #334155; text-align:center; box-shadow: 0 4px 20px rgba(0,0,0,0.3);">
              <h1 style="margin:0; color:#ef4444; font-size:28px; letter-spacing:-0.02em;">The server is unreachable.</h1>
              <p id="emergency-status" style="margin:12px 0 0 0; font-weight:700; color:#fbbf24; font-size:16px;">Status: Calculating reboot time...</p>
              <div style="margin-top:20px; display:flex; gap:12px; justify-content:center; flex-wrap:wrap;">
                <a href="https://discord.gg/hBwz45hq4z" target="_blank" style="background:#5865f2; color:white; padding:10px 20px; border-radius:8px; text-decoration:none; font-weight:bold; transition: 0.2s; box-shadow: 0 2px 8px rgba(88,101,242,0.3);">💬 Discord</a>
                <button id="em-view-players" style="background:#334155; color:white; border:1px solid #475569; padding:10px 20px; border-radius:8px; cursor:pointer; font-weight:bold; transition: 0.2s;">👥 User List</button>
                <button id="em-view-tips" style="background:#334155; color:white; border:1px solid #475569; padding:10px 20px; border-radius:8px; cursor:pointer; font-weight:bold; transition: 0.2s;">💰 Tip List</button>
              </div>
            </div>
            
            <div style="flex:1; display:flex; min-height:0; background: radial-gradient(circle at 50% 50%, #1e293b 0%, #0f172a 100%);">
                <div id="em-chat-container" style="flex:1; display:flex; flex-direction:column; padding:24px; min-width:0;">
                  <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:12px;">
                    <h3 style="margin:0; font-size:18px; color: #94a3b8;">Emergency Chat</h3>
                    <span id="em-user-count" style="font-size: 12px; color: #64748b;">Connecting...</span>
                  </div>
                  <div id="em-chat-messages" style="flex:1; overflow-y:auto; background:rgba(0,0,0,0.25); border: 1px solid rgba(255,255,255,0.05); border-radius:12px; padding:16px; display:flex; flex-direction:column; gap:10px; margin-bottom:16px; backdrop-filter: blur(4px);"></div>
                  <div style="display:flex; gap:12px; background: rgba(0,0,0,0.2); padding: 8px; border-radius: 12px; border: 1px solid rgba(255,255,255,0.05);">
                    <input type="text" id="em-chat-input" maxlength="400" placeholder="Server is down, but chat is up! Type here..." style="flex:1; background:transparent; border:none; color:white; padding:8px 12px; font-size:15px; outline:none;">
                    <button id="em-chat-img-btn" style="background:#475569; color:white; border:none; padding:0 12px; border-radius:8px; cursor:pointer; transition: 0.2s;" title="Upload Image">🖼️</button>
                    <input type="file" id="em-chat-file" accept="image/*" style="display:none;">
                    <button id="em-chat-send" style="background:#10b981; color:white; border:none; padding:0 24px; border-radius:8px; font-weight:bold; cursor:pointer; transition: 0.2s;">Send</button>
                  </div>
                </div>
                
                <div id="em-side-panel" style="width:320px; display:none; flex-direction:column; padding:24px; background:rgba(30, 41, 59, 0.5); border-left: 1px solid #334155; backdrop-filter: blur(10px); overflow-y:auto;">
                   <div style="display:flex; justify-content:space-between; align-items:center; margin-bottom:20px;">
                     <h3 id="em-side-title" style="margin:0; font-size:18px; color:#cbd5e1;"></h3>
                     <button id="em-side-close" style="background:none; border:none; color:#94a3b8; cursor:pointer; font-size:24px; line-height:1;">&times;</button>
                   </div>
                   <div id="em-side-content" style="display:flex; flex-direction:column; gap:8px;"></div>
                </div>
            </div>
            <div id="em-cursor-container" style="position:fixed; inset:0; pointer-events:none; z-index:1000000;"></div>
            <div id="notification-container" style="position:fixed; top:20px; left:50%; transform:translateX(-50%); z-index:2000000; pointer-events:none; display:flex; flex-direction:column; gap:8px;"></div>
          </div>
        `;

        // Status logic
        const updateStatusText = () => {
            const el = document.getElementById('emergency-status');
            if (!el) return;

            const now = new Date();
            const today6PM = new Date();
            today6PM.setHours(18, 0, 0, 0);

            const tomorrowMidnight = new Date();
            tomorrowMidnight.setDate(tomorrowMidnight.getDate() + 1);
            tomorrowMidnight.setHours(0, 0, 0, 0);

            let status = "Status: Unknown";
            if (now < today6PM) {
                const diff = today6PM - now;
                const h = Math.floor(diff / 3600000);
                const m = Math.floor((diff % 3600000) / 60000);
                status = `Status: Rebooting in ${h}h ${m}m (Target: 6 PM)`;
            } else if (now < tomorrowMidnight) {
                const diff = tomorrowMidnight - now;
                const h = Math.floor(diff / 3600000);
                const m = Math.floor((diff % 3600000) / 60000);
                status = `Status: Rebooting in ${h}h ${m}m (Target: 12 AM Tomorrow)`;
            }

            el.textContent = status;
        };
        updateStatusText();
        setInterval(updateStatusText, 30000);

        // Initialize simplified chat
        const room = window.multiplayerCursors?.room || new WebsimSocket();
        if (!room.initialized) await room.initialize();
        
        const chatMsgs = document.getElementById('em-chat-messages');
        const chatInput = document.getElementById('em-chat-input');
        const chatSend = document.getElementById('em-chat-send');
        const chatImgBtn = document.getElementById('em-chat-img-btn');
        const chatFileIn = document.getElementById('em-chat-file');
        const userCountSpan = document.getElementById('em-user-count');
        const sidePanel = document.getElementById('em-side-panel');
        const sideContent = document.getElementById('em-side-content');
        const cursorContainer = document.getElementById('em-cursor-container');

        const renderEmMsg = (m) => {
          const div = document.createElement('div');
          div.className = 'em-msg';
          div.style.cssText = "background:rgba(255,255,255,0.03); padding:10px 14px; border-radius:10px; border: 1px solid rgba(255,255,255,0.02); font-size:14px; line-height:1.4;";
          const time = new Date(m.created_at).toLocaleTimeString([], {hour:'2-digit', minute:'2-digit'});
          const s = (str) => String(str || '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
          
          let imgHtml = '';
          if (m.imageUrl && m.imageUrl.startsWith('https://api.websim.com')) {
              imgHtml = `<div style="margin-top:8px;"><img src="${m.imageUrl}" style="max-width:100%; max-height:300px; border-radius:8px; border:1px solid rgba(255,255,255,0.1); cursor:pointer;" onclick="window.openImageViewer('${m.imageUrl}')"></div>`;
          }

          div.innerHTML = `<div style="display:flex; justify-content:space-between; margin-bottom:4px;">
                             <strong style="color:#60a5fa;">${s(m.username)}</strong>
                             <span style="opacity:0.4; font-size:11px;">${time}</span>
                           </div>
                           <div style="color:#e2e8f0; word-break:break-word;">${s(m.message)}</div>
                           ${imgHtml}`;
          chatMsgs.appendChild(div);
          chatMsgs.scrollTop = chatMsgs.scrollHeight;
        };

        // Real-time user list helper
        const updateRealtimeUserList = () => {
          if (sidePanel.style.display === 'flex' && document.getElementById('em-side-title').textContent === "Online Users") {
            sideContent.innerHTML = '';
            Object.values(room.peers || {}).forEach(p => {
              const div = document.createElement('div');
              div.style.cssText = "padding:10px 14px; background:rgba(255,255,255,0.05); border-radius:8px; font-size:14px; display:flex; align-items:center; gap:10px;";
              div.innerHTML = `<img src="https://images.websim.com/avatar/${p.username}" style="width:24px; height:24px; border-radius:50%;"> <span>${p.username}</span>`;
              sideContent.appendChild(div);
            });
          }
        };

        // Render cursors
        const renderedCursors = new Map();
        room.subscribePresence((presence) => {
          updateRealtimeUserList();
          if (userCountSpan) {
            userCountSpan.textContent = `${Object.keys(room.peers || {}).length} users online`;
          }

          // Render cursors in overlay
          Object.entries(presence).forEach(([clientId, data]) => {
            if (clientId === room.clientId) return;
            const peer = room.peers[clientId];
            if (!peer) return;

            let el = renderedCursors.get(clientId);
            if (!el) {
              el = document.createElement('div');
              el.className = 'em-cursor';
              if (isTouchDevice) {
                el.innerHTML = `<div class="em-cursor-circle"></div><div class="em-cursor-label">${peer.username}</div>`;
                el.style.opacity = '0';
              } else {
                el.innerHTML = `<svg class="em-cursor-icon" viewBox="0 0 30 30"><path fill="#60a5fa" stroke="white" stroke-width="1" d="M18 14.88 8.16 3.15c-.26-.31-.76-.12-.76.28v15.31c0 .36.42.56.7.33l3.1-2.6 1.55 4.25c.08.22.33.34.55.26l1.61-.59a.43.43 0 0 0 .26-.55l-1.55-4.25h4.05c.36 0 .56-.42.33-.7Z"></path></svg><div class="em-cursor-label">${peer.username}</div>`;
              }
              cursorContainer.appendChild(el);
              renderedCursors.set(clientId, el);
            }

            if (typeof data.cursorX === 'number' && typeof data.cursorY === 'number') {
              const x = (data.cursorX / 100) * window.innerWidth;
              const y = (data.cursorY / 100) * window.innerHeight;
              el.style.transform = `translate(${x}px, ${y}px)`;
              
              if (isTouchDevice) {
                el.style.opacity = '1';
                clearTimeout(el._fadeTimeout);
                el._fadeTimeout = setTimeout(() => el.style.opacity = '0', 1000);
              } else {
                el.style.opacity = '1';
              }
            }
          });
          
          // Cleanup cursors
          renderedCursors.forEach((el, cid) => {
            if (!presence[cid]) {
              el.remove();
              renderedCursors.delete(cid);
            }
          });
        });

        // Global mouse tracking for emergency mode
        const overlay = document.getElementById('emergency-overlay');
        const handleMove = (e) => {
          const x = (typeof e.pageX === 'number') ? e.pageX : e.clientX;
          const y = (typeof e.pageY === 'number') ? e.pageY : e.clientY;
          room.updatePresence({
            cursorX: (x / window.innerWidth) * 100,
            cursorY: (y / window.innerHeight) * 100
          });
        };
        overlay.addEventListener('mousemove', handleMove);
        overlay.addEventListener('touchstart', (e) => {
          if (e.touches.length > 0) {
            handleMove(e.touches[0]);
          }
        });

        room.collection('emergency_chat_v1').subscribe(msgs => {
          chatMsgs.innerHTML = '';
          const sorted = [...msgs].sort((a,b) => new Date(a.created_at) - new Date(b.created_at));
          sorted.slice(-100).forEach(renderEmMsg);
        });

        let lastEmergencyMsgTime = 0;
        let lastEmergencyMsgContent = "";

        const sendMsg = async (imageUrl = null) => {
          const now = Date.now();
          const cooldown = 3000;
          const msg = chatInput.value.trim();

          if (!msg && !imageUrl) return;

          // Rate limit check
          if (now - lastEmergencyMsgTime < cooldown) {
            const remaining = Math.ceil((cooldown - (now - lastEmergencyMsgTime)) / 1000);
            if (window.showNotification) {
                window.showNotification(`Anti-spam: Please wait ${remaining}s.`, 'error');
            }
            return;
          }

          // Duplicate check (within 10 seconds)
          if (msg && msg === lastEmergencyMsgContent && (now - lastEmergencyMsgTime < 10000)) {
            if (window.showNotification) {
                window.showNotification("Please don't send duplicate messages.", "error");
            }
            return;
          }

          lastEmergencyMsgTime = now;
          lastEmergencyMsgContent = msg;
          chatInput.value = '';
          
          try {
              await room.collection('emergency_chat_v1').create({ 
                  message: msg,
                  imageUrl: imageUrl 
              });
          } catch (err) {
              console.error("Emergency send failed:", err);
              if (window.showNotification) window.showNotification("Failed to send message.", "error");
          }
        };

        chatSend.onclick = () => sendMsg();
        chatInput.onkeydown = (e) => { if(e.key === 'Enter') sendMsg(); };

        chatImgBtn.onclick = () => chatFileIn.click();
        chatFileIn.onchange = async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            
            // Validation: No SVG, Must be image
            if (!file.type.startsWith('image/') || file.type === 'image/svg+xml') {
                if (window.showNotification) window.showNotification("Please upload a valid image file. SVGs are not allowed.", "error");
                chatFileIn.value = '';
                return;
            }

            chatImgBtn.disabled = true;
            chatImgBtn.textContent = '...';
            
            try {
                const url = await window.websim.upload(file);
                if (url && url.startsWith('https://api.websim.com')) {
                    await sendMsg(url);
                } else {
                    if (window.showNotification) window.showNotification("Upload failed or returned invalid origin.", "error");
                }
            } catch (err) {
                console.error("Emergency upload error:", err);
                if (window.showNotification) window.showNotification("Image upload failed.", "error");
            } finally {
                chatImgBtn.disabled = false;
                chatImgBtn.textContent = '🖼️';
                chatFileIn.value = '';
            }
        };

        // Side panel logic
        const sideTitle = document.getElementById('em-side-title');
        const sideClose = document.getElementById('em-side-close');

        sideClose.onclick = () => sidePanel.style.display = 'none';

        document.getElementById('em-view-players').onclick = () => {
          sidePanel.style.display = 'flex';
          sideTitle.textContent = "Online Users";
          updateRealtimeUserList();
        };

        document.getElementById('em-view-tips').onclick = async () => {
          sidePanel.style.display = 'flex';
          sideTitle.textContent = "Top Supporters";
          sideContent.innerHTML = '<div style="text-align:center; padding:20px; opacity:0.6;">Loading tip data...</div>';
          try {
            const project = await window.websim.getCurrentProject();
            const [res1, res2] = await Promise.all([
              fetch(`/api/v1/projects/${project.id}/comments?only_tips=true&sort_by=best`),
              fetch(`/api/v1/projects/c4at4hxgmwbmwvhevhbm/comments?only_tips=true&sort_by=best`)
            ]);
            const data1 = await res1.json();
            const data2 = await res2.json();
            const tips = [
                ...(data1?.comments?.data || []).map(d => d.comment),
                ...(data2?.comments?.data || []).map(d => d.comment)
            ];
            const board = {};
            tips.forEach(t => { const u = t.author.username; board[u] = (board[u] || 0) + (t.card_data?.credits_spent || 0); });
            const sorted = Object.entries(board).sort((a,b) => b[1] - a[1]);
            sideContent.innerHTML = '';
            sorted.forEach(([user, amount], idx) => {
              const div = document.createElement('div');
              div.style.cssText = "padding:12px; background:rgba(251, 191, 36, 0.1); border: 1px solid rgba(251, 191, 36, 0.2); border-radius:10px; display:flex; justify-content:space-between; align-items:center;";
              const medal = idx === 0 ? '🥇 ' : idx === 1 ? '🥈 ' : idx === 2 ? '🥉 ' : '';
              div.innerHTML = `<span style="font-weight:bold;">${medal}${user}</span> <span style="color:#fbbf24; font-weight:700;">${amount} shards</span>`;
              sideContent.appendChild(div);
            });
            if (!sorted.length) sideContent.innerHTML = '<div style="text-align:center; padding:20px; opacity:0.6;">No tips found yet.</div>';
          } catch(e) { sideContent.textContent = "Error loading tips from Websim API."; }
        };
      }

      // ====== Periodic screenshot refresh ======
      let screenshotRefreshIntervalId = null;

      function refreshOsScreenshotsOnce() {
        try {
          const switcher = document.getElementById('osSwitcherContainer');
          if (!switcher) return;

          const imgs = switcher.querySelectorAll('img.vm-shot');
          imgs.forEach(img => {
            const btn = img.closest('.os-switch-btn');
            if (!btn) return;
            const oscode = btn.dataset.oscode;
            if (!oscode) return;

            const state = screenshotState.get(oscode) || { loading: false };
            if (state.loading) return; // Already loading this one

            const config = OS_CONFIGS[oscode];
            if (!config) return;
            if (config.isEmbed || config.hasManualThumbnail) return; // Don't refresh screenshots for embeds or manual thumbnails

            let screenshotUrl = `${window.apiSegment}/screenshot/${oscode}.jpeg`;
            if (config.isManualPassword) {
              const savedPassword = getVmPassword(oscode);
              if (savedPassword) {
                screenshotUrl += `?password=${encodeURIComponent(savedPassword)}`;
              }
            }

            const separator = screenshotUrl.includes('?') ? '&' : '?';
            const finalUrl = `${screenshotUrl}${separator}t=${Date.now()}`;

            // Don't reload if the src is different to avoid flicker
            if (img.src !== finalUrl) {
                img.src = finalUrl;
            }
            state.loading = false;
            screenshotState.set(oscode, state);
          });
        } catch (e) {
          console.warn('Failed to refresh screenshots:', e);
        }
      }
      
      function startScreenshotRefresh() {
        if (screenshotRefreshIntervalId) clearInterval(screenshotRefreshIntervalId);
        // Initial refresh shortly after render
        setTimeout(refreshOsScreenshotsOnce, 500);
        screenshotRefreshIntervalId = setInterval(refreshOsScreenshotsOnce, 10000); // every 10s
        console.log('Started screenshot refresh interval.');
      }


      document.addEventListener("DOMContentLoaded", () => {
        // Now, this is the first thing called on DOMContentLoaded
        fetchVMListAndInitialize();
      });

      // Rules Modal Display Function
      function showRulesModal() {
          const overlay = document.getElementById('rules-overlay');
          const modal = document.getElementById('rules-modal');
          const checkboxxer = document.getElementById('rules-checkboxx');
        window.checkboxxer = checkboxxer;
          const checkboxLabel = document.getElementById('rules-checkbox-label');
          const doneButton = document.getElementById('rules-done-btn');
          const countdownSpan = document.getElementById('rules-countdown');

          // Defensive check: ensure all required elements exist
          if (!overlay || !modal || !checkboxxer || !checkboxLabel || !doneButton) {
              console.error('Rules modal elements not found. Required elements missing:', {
                  overlay: !!overlay,
                  modal: !!modal,
                  checkbox: !!checkboxxer,
                  checkboxLabel: !!checkboxLabel,
                  doneButton: !!doneButton
              });
              return;
          }

          overlay.style.display = 'flex'; // Use flex for centering
          modal.style.display = 'flex';

          checkboxxer.disabled = true;
          doneButton.disabled = true;

          let countdown = 10;
          checkboxLabel.textContent = `I have read and agree to the rules (${countdown}s)`;

          const countdownTimer = setInterval(() => {
              countdown--;
              if (countdown > 0) {
                  checkboxLabel.textContent = `I have read and agree to the rules (${countdown}s)`;
              } else {
                  clearInterval(countdownTimer);
                  checkboxxer.disabled = false;
                  checkboxLabel.textContent = 'I have read and agree to the rules'; // Clear countdown text
              }
          }, 1000);

          checkboxxer.addEventListener('change', () => {
              doneButton.disabled = !checkboxxer.checked;
          });

          doneButton.addEventListener('click', async () => {
              if (checkboxxer.checked) {
                  localStorage.setItem('websimRulessAccepted', 'true');
                  overlay.style.display = 'none';
                  modal.style.display = 'none';
                  // Next enforce VM-specific rules then enter VM
                  await enterVm(window.selected);
              }
          }, { once: true });
      }

      // Patch readQueryVariable to use selected variable, not any path
      window.__inject_OS_config = (() => {
        const getConfig = () => OS_CONFIGS[selected];

        window.__orig_readQVar = window.__orig_readQVar || window.readQueryVariable;
        window.readQuery = function(name, defaultValue) {
          const config = getConfig();
          if (config) {
            switch (name) {
              case "host": return config.host;
              case "port": return 443; // ALWAYS 400
              case "password":
                // For password-less configs (manual input), return stored password if available
                if (config.isManualPassword && customPasswords[selected]) {
                  return customPasswords[selected];
                }
                return config.password;
              case "path": return config.path;
            }
          }
          if (window.__orig_readQVar)
            return window.__orig_readQVar(name, defaultValue);
          return defaultValue;
        };
      })();

      // ---- [START] Reconnect-on-disconnect logic ----
      let reconnectTimer = null;
      let reconnectCountdown = 0;
      let reconnectDelayMs = 1000;
      async function tryReconnect() {
        if (isBanned()) {
            showBannedMessage();
            if (reconnectTimer) clearTimeout(reconnectTimer);
            return;
        }

        // Check for special state first
        if (window.__specialState) {
            handleSpecialScreen(window.__specialState, window.__specialData);
            if (reconnectTimer) clearTimeout(reconnectTimer);
            return;
        }

        // Check blacklist before reconnecting
        const canAccess = await checkVmBlacklist(selected);
        if (!canAccess) {
            if (reconnectTimer) clearTimeout(reconnectTimer);
            return;
        }
        if (rfb && (rfb._websocket?.readyState === 1 || rfb._websocket?.readyState === 0)) {
          reconnectCountdown = 0;
          reconnectTimer && clearTimeout(reconnectTimer);
          reconnectTimer = null;
          return;
        }
        if (reconnectTimer) return;
        reconnectCountdown++;
        document.getElementById("status").textContent = "Reconnecting... ("+reconnectCountdown+")";
        // Compose url for reconnect. Uses the global 'selected' variable via OS_CONFIGS.
        const config = OS_CONFIGS[selected];
        if (!config) {
            console.error("No config for selected OS:", selected, " - VM list might not be loaded yet. Retrying in 1s.");
            reconnectTimer = setTimeout(tryReconnect, reconnectDelayMs); // Retry
            return;
        }
        
        const wsProtocol = window.location.protocol === 'https:' ? 'wss:' : 'ws:';
        let url = `${wsProtocol}//${window.location.host}${window.apiSegment}${config.path}`;
        let separator = url.includes('?') ? '&' : '?';

        // Determine password to use
        let password = config.password;
        if (config.isManualPassword && customPasswords[selected]) {
          password = customPasswords[selected];
        }

        // If password is set, add to query string
        if (password) {
            url += separator + "password=" + encodeURIComponent(password);
            separator = '&';
        }

        url += separator + "origin=" + encodeURIComponent(window.location.href);
        separator = '&';

        try {
            const user = await window.websim.getCurrentUser();
            if (user && user.username) {
                url += separator + "username=" + encodeURIComponent(user.username);
            }
        } catch (e) {
            console.warn("Could not get username for query:", e);
        }

        try {
          const screenElem = document.getElementById("screen");
          if (screenElem) screenElem.innerHTML = '';
          const RFB_Class = (typeof RFB === 'function') ? RFB : (RFB.default || RFB);
          const newrfb = new RFB_Class(screenElem, url, {
            credentials: { password: password },
            viewOnly: readQueryVariable("view_only", false),
            scaleViewport: true,
            resizeSession: false,
            showDotCursor: true,
            wsProtocols: ['binary']
          });
          window.rfb = rfb = newrfb;
          rfb.addEventListener("connect", connectedToServer);
          rfb.addEventListener("disconnect", disconnectedFromServer);
          rfb.addEventListener("credentialsrequired", credentialsAreRequired);
          rfb.addEventListener("desktopname", updateDesktopName);
          rfb.addEventListener("clipboard", handleClipboardFromServer);
          
          reconnectCountdown = 0;
          if (reconnectTimer) { clearTimeout(reconnectTimer); }
          reconnectTimer = null;
        } catch (e) {
          document.getElementById("status").textContent = "Reconnect failed... Retrying";
          reconnectTimer = setTimeout(tryReconnect, reconnectDelayMs);
        }
      }
      // ---- [END] Reconnect-on-disconnect logic ----

      // Chat Minimize functionality
      document.addEventListener('DOMContentLoaded', () => {
        const chatContainer = document.getElementById('chatContainer');
        const chatMinBtn = document.getElementById('chatMinimizeBtn');
        if (chatContainer && chatMinBtn) {
          chatMinBtn.addEventListener('click', () => {
            chatContainer.classList.toggle('minimized');
            if (chatContainer.classList.contains('minimized')) {
              chatMinBtn.textContent = '+';
              chatMinBtn.title = 'Maximize chat';
            } else {
              chatMinBtn.textContent = '–';
              chatMinBtn.title = 'Minimize chat';
              const chatInput = document.getElementById('chatTextInput');
              if (chatInput) chatInput.focus();
              const chatMessages = document.getElementById('chatMessages');
              if (chatMessages) {
                // Ensure layout has updated after removing minimized class
                setTimeout(() => {
                  chatMessages.scrollTop = chatMessages.scrollHeight;
                }, 50);
              }
            }
          });
        }
      });

      let rfb;
      let desktopName;

      function connectedToServer(e) {
        setStatus("Connected to " + desktopName);
        if (reconnectTimer) {
          clearTimeout(reconnectTimer);
          reconnectTimer = null;
          reconnectCountdown = 0;
        }
        // Only update status to "Ready" if multiplayer is not yet ready
        // (multiplayer sets status to "Ready" immediately when it initializes)
        if (window.multiplayerCursors && window.multiplayerCursors.room) {
          setTimeout(() => {
            if (document.getElementById("status").textContent !== "Ready") {
              setStatus("Ready");
            }
          }, 500);
        }
      }

      function disconnectedFromServer(e) {
        if (e.detail.clean) {
          setStatus("Disconnected");
        } else {
          setStatus("Something went wrong, connection is closed");
        }
        if (reconnectTimer) clearTimeout(reconnectTimer);
        reconnectTimer = setTimeout(tryReconnect, reconnectDelayMs);
      }

      function credentialsAreRequired(e) {
        const password = prompt("Password required:");
        rfb.sendCredentials({ password: password });
      }

      function updateDesktopName(e) {
        desktopName = e.detail.name;
      }

      function handleClipboardFromServer(e) {
        const clipboardText = e.detail.text;
        console.log('Received clipboard data from server:', clipboardText.substring(0, 50) + '...');
        
        navigator.clipboard.writeText(clipboardText).then(() => {
          console.log('Successfully copied server clipboard data to local clipboard');
        }).catch(err => {
          console.error('Failed to write server clipboard data to local clipboard:', err);
        });
      }

      function sendCtrlAltDel() {
        rfb.sendCtrlAltDel();
        return false;
      }

      // function setStatus is now defined near the top to allow usage throughout.

      function readQueryVariable(name, defaultValue) {
        const re = new RegExp(".*[?&]" + name + "=([^&#]*)"),
          match = document.location.href.match(re);

        if (match) {
          return decodeURIComponent(match[1]);
        }

        return defaultValue;
      }

      document.getElementById("sendCtrlAltDelButton").onclick = sendCtrlAltDel;

      /**
       * Performs a full system reconnection:
       * 1. Shows the global loading overlay
       * 2. Refreshes the VM Server list
       * 3. Reconnects WebsimSocket (Chat, Players, Cursors)
       * 4. Reconnects the active VNC/Embed connection
       */
      const netReconnectBtn = document.getElementById('network-reconnect-btn');
      if (netReconnectBtn) {
        netReconnectBtn.addEventListener('click', () => location.reload());
      }

      // New Key Combo Helper
      window.sendKeyCombo = function(combo) {
          if (!window.rfb) return;
          console.log("Sending combo:", combo);
          switch(combo) {
              case 'alt-f4':
                  rfb.sendKey(0xffe9, 'AltLeft', true); // Alt
                  rfb.sendKey(0xffc1, 'F4', true);      // F4
                  rfb.sendKey(0xffc1, 'F4', false);
                  rfb.sendKey(0xffe9, 'AltLeft', false);
                  break;
              case 'alt-tab':
                  rfb.sendKey(0xffe9, 'AltLeft', true); // Alt
                  rfb.sendKey(0xff09, 'Tab', true);      // Tab
                  rfb.sendKey(0xff09, 'Tab', false);
                  rfb.sendKey(0xffe9, 'AltLeft', false);
                  break;
              case 'win-r':
                  rfb.sendKey(0xffeb, 'MetaLeft', true); // Win
                  rfb.sendKey(0x0072, 'KeyR', true);      // R
                  rfb.sendKey(0x0072, 'KeyR', false);
                  rfb.sendKey(0xffeb, 'MetaLeft', false);
                  break;
              case 'win':
                  rfb.sendKey(0xffeb, 'MetaLeft', true);
                  rfb.sendKey(0xffeb, 'MetaLeft', false);
                  break;
              case 'ctrl-esc':
                  rfb.sendKey(0xffe3, 'ControlLeft', true);
                  rfb.sendKey(0xff1b, 'Escape', true);
                  rfb.sendKey(0xff1b, 'Escape', false);
                  rfb.sendKey(0xffe3, 'ControlLeft', false);
                  break;
          }
      };

      // Wire up bottom bar shortcuts
      document.addEventListener('DOMContentLoaded', () => {
          document.querySelectorAll('.shortcut-btn').forEach(btn => {
              btn.addEventListener('click', () => {
                  const combo = btn.dataset.shortcut;
                  if (combo) window.sendKeyCombo(combo);
              });
          });
      });

      // Centralize UI button actions for reuse in mobile options
      const uiActions = {
          reconnect: () => reconnectCurrent(),
          fullReconnect: () => location.reload(),
          tutorial: async () => {
            try { await showMainTutorial(true); } catch(e) { showCustomPopup('Tutorial', 'Tutorial not available.', [{text:'OK', value:true}]); }
          },
          report: async () => {
              const osCode = window.selected;
              const vmName = OS_CONFIGS[osCode]?.name || osCode;
              const reason = await openReportModal(vmName);
              if (reason === null) return;
              try {
                  const url = `${window.apiSegment}/report/${osCode}?reason=${encodeURIComponent(reason)}`;
                  const response = await fetch(url);
                  if (!response.ok) throw new Error();
                  showNotification('Report sent!', 'success');
              } catch (err) {
                  showNotification('Failed to send report.', 'error');
              }
          },
          retypePassword: async () => {
              const oscode = window.selected;
              const config = OS_CONFIGS[oscode];
              if (config?.isManualPassword) {
                  const osName = OS_OPTIONS.find(o => o.code === oscode)?.name || oscode;
                  const pw = await openManualPasswordModal(oscode, osName);
                  if (pw) { customPasswords[oscode] = pw; reconnectCurrent(); }
              }
          },
          cloudStorage: () => window.open('https://cloud-storage--datavm.on.websim.com', '_blank', 'noopener'),
          discord: () => window.open('https://discord.gg/hBwz45hq4z', '_blank', 'noopener'),
          wiki: () => window.open('https://e1x8.xyz/dokuwiki/doku.php?id=start', '_blank', 'noopener'),
          players: () => window.multiplayerCursors?.togglePlayerList(),
          profile: () => {
              if(window.multiplayerCursors) {
                  window.multiplayerCursors.showProfilePopup(window.multiplayerCursors.currentUserId, window.multiplayerCursors.currentUsername);
              }
          },
          announcement: () => document.getElementById('announcementComposerToggle')?.click(),
          themes: () => document.getElementById('custom-themes-button')?.click(),
          tipjar: () => document.getElementById('tip-jar-button')?.click(),
          settings: () => document.getElementById('settings-button')?.click(),
          selfHost: () => openSelfHostModal(),
          screenshot: () => {
              if (window.screenshot) {
                  window.screenshot();
              } else {
                  showNotification('Screenshot tool loading...', 'info');
              }
          }
      };

      document.addEventListener('DOMContentLoaded', () => {
        const header = document.getElementById('header-bar');
        const headerControls = document.getElementById('header-controls');
        if (!header || !headerControls) return;

        // Function to toggle Controls button visibility based on selected VM
        function updateControlsBtn() {
            const cfg = OS_CONFIGS[window.selected];
            const hasControls = cfg?.extras?.controls && Object.keys(cfg.extras.controls).length > 0;
            const vmControlsBtn = document.getElementById('vm-header-controls-btn');
            if (vmControlsBtn) {
                vmControlsBtn.style.display = hasControls ? 'inline-flex' : 'none';
                if (hasControls) {
                    vmControlsBtn.classList.add('has-active-controls');
                } else {
                    vmControlsBtn.classList.remove('has-active-controls');
                }
            }
        }

        // Add Reconnect button
        const reconnectBtn = document.createElement('button');
        reconnectBtn.id = 'reconnect-btn';
        reconnectBtn.className = 'header-icon-btn mobile-hide';
        reconnectBtn.innerHTML = '↻ <span class="btn-text">Reconnect</span>';
        reconnectBtn.title = 'Reconnect';
        reconnectBtn.addEventListener('click', uiActions.reconnect);
        headerControls.appendChild(reconnectBtn);

        // Tutorial button — opens the main quick tutorial
        const tutorialBtn = document.createElement('button');
        tutorialBtn.id = 'tutorial-button';
        tutorialBtn.className = 'header-icon-btn mobile-hide';
        tutorialBtn.innerHTML = '📘 <span class="btn-text">Tutorial</span>';
        tutorialBtn.title = 'Open Tutorial';
        tutorialBtn.addEventListener('click', async () => {
            // Show the main tutorial function defined in index.html
            try {
                await showMainTutorial(true);
            } catch (e) {
                // fallback: show a simple popup
                showCustomPopup('Tutorial', 'Tutorial is not available right now.', [{ text: 'OK', value: true }], false);
            }
        });
        headerControls.appendChild(tutorialBtn);

        // Add VM Controls button (🕹️)
        const vmControlsBtn = document.createElement('button');
        vmControlsBtn.id = 'vm-header-controls-btn';
        vmControlsBtn.className = 'header-icon-btn mobile-hide';
        vmControlsBtn.innerHTML = '🕹️ <span class="btn-text">Controls</span>';
        vmControlsBtn.title = 'VM Actions & Controls';
        vmControlsBtn.style.display = 'none'; // Hidden by default
        vmControlsBtn.style.background = 'rgba(79, 211, 255, 0.1)';
        vmControlsBtn.style.borderColor = 'rgba(79, 211, 255, 0.3)';
        vmControlsBtn.addEventListener('click', () => {
            if (window.selected) {
                openVmRulesModal(window.selected);
            }
        });
        headerControls.appendChild(vmControlsBtn);

        // Add Report button
        const reportBtn = document.createElement('button');
        reportBtn.id = 'report-button';
        reportBtn.className = 'header-icon-btn mobile-hide';
        reportBtn.innerHTML = '🚩 <span class="btn-text">Report</span>';
        reportBtn.title = 'Report this VM';
        reportBtn.addEventListener('click', uiActions.report);
        headerControls.appendChild(reportBtn);

        // Add Cloud Storage button
        const cloudBtn = document.createElement('button');
        cloudBtn.id = 'cloud-storage-btn';
        cloudBtn.className = 'header-icon-btn mobile-hide';
        cloudBtn.innerHTML = '☁️ <span class="btn-text">Cloud</span>';
        cloudBtn.title = 'Open Cloud Storage';
        cloudBtn.addEventListener('click', uiActions.cloudStorage);
        headerControls.appendChild(cloudBtn);

        // Add Retype Password button
        const retypePasswordBtn = document.createElement('button');
        retypePasswordBtn.id = 'retype-password-btn';
        retypePasswordBtn.className = 'header-icon-btn mobile-hide';
        retypePasswordBtn.innerHTML = '🔑 <span class="btn-text">Password</span>';
        retypePasswordBtn.title = 'Retype Password';
        retypePasswordBtn.addEventListener('click', uiActions.retypePassword);
        headerControls.appendChild(retypePasswordBtn);

        // Add Wiki button
        const wikiBtn = document.createElement('button');
        wikiBtn.id = 'wiki-button';
        wikiBtn.className = 'header-icon-btn mobile-hide';
        wikiBtn.innerHTML = '📖 <span class="btn-text">Wiki</span>';
        wikiBtn.title = 'Open Wiki';
        wikiBtn.addEventListener('click', uiActions.wiki);
        headerControls.appendChild(wikiBtn);

        // Add Self Host button
        const selfHostBtn = document.createElement('button');
        selfHostBtn.id = 'self-host-btn';
        selfHostBtn.className = 'header-icon-btn mobile-hide';
        selfHostBtn.innerHTML = '🚀 <span class="btn-text">Self-Host</span>';
        selfHostBtn.title = 'Self-Host a VM';
        selfHostBtn.addEventListener('click', uiActions.selfHost);
        headerControls.appendChild(selfHostBtn);

        // Add Discord button
        const discordBtn = document.createElement('button');
        discordBtn.id = 'discord-button';
        discordBtn.className = 'header-icon-btn mobile-hide';
        discordBtn.innerHTML = `<img src="https://www.svgrepo.com/show/353655/discord-icon.svg" alt="Discord" style="width:16px;height:16px;" /> <span class="btn-text">Discord</span>`;
        discordBtn.title = 'Join Discord';
        discordBtn.addEventListener('click', uiActions.discord);
        headerControls.appendChild(discordBtn);

        // Add Screenshot button
        const screenshotBtn = document.createElement('button');
        screenshotBtn.id = 'screenshot-button';
        screenshotBtn.className = 'header-icon-btn mobile-hide';
        screenshotBtn.innerHTML = '📸 <span class="btn-text">Screenshot</span>';
        screenshotBtn.title = 'Take Screenshot';
        screenshotBtn.addEventListener('click', uiActions.screenshot);
        headerControls.appendChild(screenshotBtn);

        window.addEventListener('selected-os-changed', updateControlsBtn);
        window.addEventListener('vm-list-updated', updateControlsBtn);
        
        // Initial check
        updateControlsBtn();
        setTimeout(updateControlsBtn, 500);
        setTimeout(updateControlsBtn, 2000);

        // Setup Mobile Options Menu
        const mobileToggle = document.getElementById('mobile-options-toggle');
        const mobileOverlay = document.getElementById('mobile-options-overlay');
        const mobileList = document.getElementById('mobile-options-list');
        const mobileClose = document.getElementById('mobile-options-close');

        if (mobileToggle && mobileOverlay && mobileList) {
            mobileToggle.onclick = () => {
                mobileList.innerHTML = '';
                const options = [
                    { name: '👤 Profile', action: 'profile' },
                    { name: '👥 Players', action: 'players' },
                    { name: '↻ Reconnect', action: 'reconnect' },
                    { name: '📘 Tutorial', action: 'tutorial' },
                    { name: '📢 Announce', action: 'announcement' },
                    { name: '🎨 Themes', action: 'themes' },
                    { name: '💰 Tip Jar', action: 'tipjar' },
                    { name: '⚙️ Settings', action: 'settings' },
                    { name: '🚀 Self Host', action: 'selfHost' },
                    { name: '📸 Screenshot', action: 'screenshot' },
                    { name: '🚩 Report VM', action: 'report' },
                    { name: '🔑 Retype PW', action: 'retypePassword' },
                    { name: '☁️ Cloud Storage', action: 'cloudStorage' },
                    { name: '💬 Discord', action: 'discord' },
                    { name: '📖 Wiki', action: 'wiki' },
                    { name: '🌐 Network', action: 'fullReconnect' }
                ];

                options.forEach(opt => {
                    const row = document.createElement('div');
                    row.className = 'mobile-option-row';
                    row.textContent = opt.name;
                    row.onclick = () => {
                        mobileOverlay.style.display = 'none';
                        uiActions[opt.action]();
                    };
                    mobileList.appendChild(row);
                });
                mobileOverlay.style.display = 'flex';
            };
            mobileClose.onclick = () => mobileOverlay.style.display = 'none';
            mobileOverlay.onclick = (e) => { if(e.target === mobileOverlay) mobileOverlay.style.display = 'none'; };
        }
      });

      // Bottom bar setup
      document.addEventListener('DOMContentLoaded', () => {
        const keyboardBtn = document.getElementById('keyboard-button');
        const hiddenInput = document.getElementById('hidden-keyboard-input');
        const cadBtn = document.getElementById('sendCtrlAltDelButton-bottom');

        if (keyboardBtn && hiddenInput) {
          keyboardBtn.addEventListener('click', () => {
            hiddenInput.focus();
          });
        }
        
        if (cadBtn) {
            cadBtn.addEventListener('click', () => {
                if (window.rfb) {
                    sendCtrlAltDel();
                }
            });
        }
      });

      // ===== Report Modal Logic =====
      async function openReportModal(vmName) {
        return new Promise((resolve) => {
          const overlay = document.getElementById('report-modal-overlay');
          const modal = document.getElementById('report-modal');
          const vmNameEl = document.getElementById('report-modal-vm-name');
          const reasonEl = document.getElementById('report-modal-reason');
          const cancelBtn = document.getElementById('report-modal-cancel');
          const submitBtn = document.getElementById('report-modal-submit');

          if (!overlay || !modal || !vmNameEl || !reasonEl || !cancelBtn || !submitBtn) {
            console.error('Report modal elements not found!');
            // Fallback to prompt if UI is broken
            const reason = prompt(`Reason for reporting ${vmName}:`);
            resolve(reason);
            return;
          }

          vmNameEl.textContent = `Reporting: ${vmName}`;
          reasonEl.value = '';
          submitBtn.disabled = true;

          const checkReason = () => {
            submitBtn.disabled = reasonEl.value.trim().length === 0;
          };
          reasonEl.addEventListener('input', checkReason);

          const cleanupAndClose = (value) => {
            reasonEl.removeEventListener('input', checkReason);
            overlay.style.display = 'none';
            resolve(value);
          };

          cancelBtn.onclick = () => cleanupAndClose(null);
          submitBtn.onclick = () => cleanupAndClose(reasonEl.value.trim());
          overlay.onclick = (e) => {
            if (e.target === overlay) {
              cleanupAndClose(null);
            }
          };

          overlay.style.display = 'flex';
          setTimeout(() => reasonEl.focus(), 50);
        });
      }

      // ===== Manual Password Modal Logic =====
      function ensureManualPasswordModal() {
        let overlay = document.getElementById('manual-password-overlay');
        let modal = document.getElementById('manual-password-modal');

        // Create if missing
        if (!overlay) {
          overlay = document.createElement('div');
          overlay.id = 'manual-password-overlay';
          overlay.style.display = 'none';
          document.body.appendChild(overlay);
        }
        if (!modal) {
          modal = document.createElement('div');
          modal.id = 'manual-password-modal';
          modal.style.display = 'none';
          overlay.appendChild(modal);
        } else {
          // Ensure the modal is a child of the overlay
          if (modal.parentElement !== overlay) {
            overlay.appendChild(modal);
          }
        }

        // If modal exists but hasn't been populated yet (or was empty in HTML),
        // populate it with the expected structure so querySelector works.
        if (!modal.querySelector('#mpm-vmname')) {
          modal.innerHTML = `
            <h3>Enter VM Password</h3>
            <div class="mpm-sub">This VM requires a password to connect.</div>
            <div class="mpm-vm" id="mpm-vmname"></div>
            <div class="mpm-field">
              <input type="password" id="manual-password-input" placeholder="Password" autocomplete="current-password" />
            </div>
            <div id="manual-password-actions">
              <button class="mpm-btn" id="mpm-cancel">Cancel</button>
              <button class="mpm-btn" id="mpm-submit">Connect</button>
            </div>
          `;
        }

        return { overlay, modal };
      }

      function closeManualPasswordModal() {
        const overlay = document.getElementById('manual-password-overlay');
        const modal = document.getElementById('manual-password-modal');
        if (overlay) overlay.style.display = 'none';
        if (modal) modal.style.display = 'none';
      }

      async function openManualPasswordModal(oscode, vmName) {
        const { overlay, modal } = ensureManualPasswordModal();

        // In case an old empty modal slipped through, ensure structure now
        if (!modal.querySelector('#mpm-vmname')) {
          modal.innerHTML = `
            <h3>Enter VM Password</h3>
            <div class="mpm-sub">This VM requires a password to connect.</div>
            <div class="mpm-vm" id="mpm-vmname"></div>
            <div class="mpm-field">
              <input type="password" id="manual-password-input" placeholder="Password" autocomplete="current-password" />
            </div>
            <div id="manual-password-actions">
              <button class="mpm-btn" id="mpm-cancel">Cancel</button>
              <button class="mpm-btn" id="mpm-submit">Connect</button>
            </div>
          `;
        }

        const nameEl = modal.querySelector('#mpm-vmname');
        const inputEl = modal.querySelector('#manual-password-input');
        const submitBtn = modal.querySelector('#mpm-submit');
        const cancelBtn = modal.querySelector('#mpm-cancel');

        // Guard against unexpected DOM issues
        if (!nameEl || !inputEl || !submitBtn || !cancelBtn) {
          console.error('Manual password modal missing elements');
          return null;
        }

        nameEl.textContent = `VM: ${vmName}`;
        inputEl.value = '';

        return new Promise((resolve) => {
          const cleanup = () => {
            submitBtn.onclick = null;
            cancelBtn.onclick = null;
            overlay.onclick = null;
            inputEl.onkeydown = null;
          };

          submitBtn.onclick = () => {
            const val = (inputEl.value || '').trim();
            if (!val) return;
            cleanup();
            closeManualPasswordModal();
            saveVmPassword(oscode, val); // Save the entered password
            resolve(val);
          };
          cancelBtn.onclick = () => {
            cleanup();
            closeManualPasswordModal();
            resolve(null);
          };
          overlay.onclick = (e) => {
            if (e.target === overlay) {
              cleanup();
              closeManualPasswordModal();
              resolve(null);
            }
          };
          inputEl.onkeydown = (e) => {
            if (e.key === 'Enter') submitBtn.click();
            if (e.key === 'Escape') cancelBtn.click();
          };

          overlay.style.display = 'flex';
          modal.style.display = 'block';
          setTimeout(() => inputEl.focus(), 50);
        });
      }

      // Helper to check blacklist status and show popup
      async function checkVmBlacklist(oscode) {
        const config = OS_CONFIGS[oscode];
        if (!config || !config.isBlacklisted) {
          return true; // Not blacklisted, can proceed
        }

        const reason = config.blacklistReason || 'This VM is not available';
        let message = reason;
        
        if (reason.toLowerCase() === 'whitelist') {
          message = 'This VM uses a whitelist system and you are not currently whitelisted for access.';
        }

        await showCustomPopup(
          'Access Denied',
          message,
          [{ text: 'OK', value: true, class: 'primary' }]
        );

        return false; // Blacklisted, cannot proceed
      }

      async function generateAiTheme(prompt, parentId = null, retryId = null) {
            const cssInput = document.getElementById('create-theme-css');
            const versionId = retryId || crypto.randomUUID();
            const timestamp = Date.now();
            
            if (!retryId) {
                // Create new pending version, annotate with the user who created it
                let creatorUsername = 'unknown';
                try {
                    const u = await window.websim.getCurrentUser();
                    if (u && u.username) creatorUsername = u.username;
                } catch (e) {}
                themeHistory.push({
                    id: versionId,
                    timestamp,
                    prompt,
                    css: '',
                    status: 'pending',
                    parentId: parentId || activeVersionId,
                    username: creatorUsername
                });
            } else {
                // Update existing to pending
                const v = themeHistory.find(v => v.id === retryId);
                if(v) {
                    v.status = 'pending';
                    v.errorMsg = null;
                    // refresh username in case it was missing
                    try {
                        const u = await window.websim.getCurrentUser();
                        if (u && u.username) v.username = u.username;
                    } catch (e) {}
                }
            }
            
            renderHistoryList();
            activeVersionId = versionId; // Switch focus to new version immediately

            try {
                // Use cached base CSS
                let baseCss = baseCssContent;
                if (!baseCss) {
                        const res = await fetch('style.css');
                        baseCss = await res.text();
                }
                
                if (baseCss.length > 20000) baseCss = baseCss.substring(0, 20000) + "...";

                // Get context from parent if available
                let contextCss = "";
                const parentV = themeHistory.find(v => v.id === (parentId || activeVersionId));
                
                // Build history context string
                let historyContext = "";
                if (parentV) {
                    const chain = [];
                    let curr = parentV;
                    // Limit to last 10 steps
                    while(curr && chain.length < 10) {
                        chain.unshift(curr);
                        curr = themeHistory.find(v => v.id === curr.parentId);
                    }
                    
                    if (chain.length > 0) {
                        historyContext = "Previous requests in this history chain (oldest first):\n" + chain.map((v, i) => `${i+1}. "${v.prompt}"`).join("\n") + "\n\n";
                    }
                }

                if (parentV && parentV.status === 'completed') {
                    contextCss = parentV.css;
                } else {
                    contextCss = cssInput.value.trim();
                }

                let projectTitle = "Unknown";
                try {
                    const p = await window.websim.getCurrentProject();
                    if (p && p.title) projectTitle = p.title;
                } catch(e) {}

                // If this generation is a retry, append a long explanatory note for the AI
                const isRetry = !!retryId;
                let retryNote = "";
                if (isRetry) {
                    retryNote = `

RETRY CONTEXT / IMPORTANT NOTE:
This request is a retry of a previous AI generation. Treat the user's new request as intended to correct or improve a prior output that failed or produced undesired results. Do not assume the previous generated CSS is authoritative — instead:
- Respect the original prompt but focus on addressing likely failure modes (e.g., missing rules, unreadable text colors, incorrect use of 'background' vs 'background-color', selectors that don't apply in the isolated preview).
- Preserve backward-compatibility with the project's base CSS; avoid breaking layout assumptions.
- If the prior attempt errored, make the generated CSS resilient: include explicit fallback colors, minimal specificity when possible, and avoid overly broad selectors that could override unrelated components.
- Explain nothing to the user in your output; this note is only guidance for you. Output must remain ONLY valid CSS with no commentary.
- Keep this generation conservative where uncertainty exists, but prioritize fixing the aspects that commonly cause failures (contrast, missing areas, and use of 'background' instead of 'background-color').
End of retry note.

`;
                }

                const systemPrompt = `You are a CSS expert. Generate CSS for a custom theme for the project "${projectTitle}" based on the user's request: "${prompt}".

NOTE: websim.com is the hosting platform for this project and its images. It is NOT a typosquatting site. Treat references to websim.com as valid internal resources.

${historyContext}IMPORTANT: You must style EVERYTHING to match the theme.
Key areas:
1. GLOBAL (body, html, #screen)
2. HEADER (#header-bar, .header-icon-btn)
3. CHAT (#chatContainer, messages, bubbles, input)
4. OS SELECTION (#osSwitcherContainer, .os-switch-btn)
5. MODALS (#settings-panel, .custom-popup-modal)
6. ANNOUNCEMENTS (#announcementBar)

IMPORTANT RULE: Always use the 'background' property instead of 'background-color' to ensure overrides work correctly against existing styles (e.g. gradients).
Ensure text colors (color property) are readable against your backgrounds for all elements.

Base CSS context:
\`\`\`css
${baseCss}
\`\`\`

Current/Parent CSS (modify this):
\`\`\`css
${contextCss}
\`\`\`

Output ONLY valid CSS. No markdown.${retryNote}`;

                const completion = await window.websim.chat.completions.create({
                    messages: [
                        { role: "user", content: systemPrompt }
                    ]
                });

                let generatedCss = completion.content.trim();
                generatedCss = generatedCss.replace(/^```css\s*/i, '').replace(/^```\s*/i, '').replace(/\s*```$/, '');

                // Update version
                const v = themeHistory.find(v => v.id === versionId);
                if (v) {
                    v.css = generatedCss;
                    v.status = 'completed';
                    cssInput.value = generatedCss;
                    updateThemePreview(generatedCss);
                }

            } catch (e) {
                console.error("AI Generation failed", e);
                const v = themeHistory.find(v => v.id === versionId);
                if (v) {
                    v.status = 'error';
                    v.errorMsg = "Generation failed";
                }
            } finally {
                renderHistoryList();
            }
        }

      // === VM Moderator Action Handler ===
      async function handleVmModAction(action, vmData) {
        const path = '/' + vmData.code;
        const config = OS_CONFIGS[vmData.code];
        
        try {
            switch(action) {
                case 'disable':
                case 'enable':
                    await sendModRequest({ [action + 'VM']: { path } });
                    break;
                case 'hide':
                case 'show':
                    const modInfo = window.modResponseData?.PORT_MAP?.[path];
                    if (!modInfo) {
                        showNotification("Accurate moderator data not available for this action.", "error");
                        return;
                    }
                    const newExtras = { ...(modInfo.extras || {}) };
                    newExtras.hidden = (action === 'hide');
                    await sendModRequest({ 
                        editPortMap: { 
                            path, 
                            name: modInfo.name, 
                            icon: modInfo.icon, 
                            port: modInfo.port, 
                            extras: newExtras 
                        } 
                    });
                    break;
                case 'delete':
                    if (confirm(`PERMANENTLY DELETE VM ${vmData.name} (${path})? This cannot be undone.`)) {
                        await sendModRequest({ removePortMap: path });
                    }
                    break;
                case 'edit':
                    await openEditVmModal(vmData);
                    break;
                case 'kickall':
                    if (confirm(`Kick ALL players currently in ${vmData.name}?`)) {
                        await sendModRequest({ kickPath: path });
                    }
                    break;
            }
            if (action !== 'kickall') {
                if (window.multiplayerCursors && typeof window.multiplayerCursors.refreshModeratorData === 'function') {
                    await window.multiplayerCursors.refreshModeratorData();
                } else {
                    refreshVMList();
                }
            }
        } catch(e) {
            console.error("Mod action failed", e);
            showNotification("Mod action failed", "error");
        }
      }

      async function sendModRequest(payload) {
          // Get current moderator credentials for authorized actions
          let auth = {};
          try {
              auth = JSON.parse(localStorage.getItem('moderator_auth_v1')) || {};
          } catch (e) {}

          const fullPayload = {
              username: auth.username,
              password: auth.password,
              ...payload
          };

          const response = await fetch('https://e1x8.xyz/moderator', {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(fullPayload)
          });
          if (!response.ok) throw new Error("API Error: " + response.status);
          showNotification("Action successful", "success");
          return response.json();
      }

      async function openSelfHostModal(vmData = null) {
        const overlay = document.getElementById('self-host-overlay');
        const modal = document.getElementById('self-host-modal');
        const titleEl = document.getElementById('self-host-title');
        const errorContainer = document.getElementById('sh-error-container');
        if (!overlay || !modal) return;

        const nameIn = document.getElementById('sh-name');
        const pathIn = document.getElementById('sh-path');
        const locationIn = document.getElementById('sh-location');
        const iconIn = document.getElementById('sh-icon');
        const catIn = document.getElementById('sh-categories');
        const descIn = document.getElementById('sh-desc');
        
        const advToggle = document.getElementById('toggle-sh-advanced');
        const advFields = document.getElementById('sh-advanced-fields');
        const passIn = document.getElementById('sh-password');
        const manualPwIn = document.getElementById('sh-manual-pw');
        const rulesIn = document.getElementById('sh-rules');
        const promptIn = document.getElementById('sh-prompt');
        
        const cancelBtn = document.getElementById('sh-cancel');
        const submitBtn = document.getElementById('sh-submit');
        const tutorialBtn = document.getElementById('sh-tutorial-btn');
        const tutorialOverlay = document.getElementById('sh-tutorial-overlay');
        const tutorialClose = document.getElementById('sh-tutorial-close');

        if (tutorialBtn && tutorialOverlay && tutorialClose) {
            tutorialBtn.onclick = () => tutorialOverlay.style.display = 'flex';
            tutorialClose.onclick = () => tutorialOverlay.style.display = 'none';
            tutorialOverlay.onclick = (e) => { if (e.target === tutorialOverlay) tutorialOverlay.style.display = 'none'; };
        }

        // Populate or Reset
        if (vmData) {
            titleEl.textContent = 'Edit Self-Hosted VM';
            submitBtn.textContent = 'Save Changes';
            nameIn.value = vmData.name || '';
            pathIn.value = vmData.code || '';
            pathIn.disabled = true; // Cannot change path when editing
            
            // Reconstruct location (VNC Endpoint)
            const cfg = OS_CONFIGS[vmData.code];
            if (cfg) {
                locationIn.value = (cfg.ip || '') + (cfg.wsPath || '');
                iconIn.value = cfg.icon || '';
                catIn.value = (cfg.extras?.categories || []).filter(c => c !== 'private server').join(', ');
                descIn.value = cfg.description || '';
                passIn.value = cfg.password || '';
                manualPwIn.checked = !!cfg.isManualPassword;
                rulesIn.value = (cfg.rules || []).join('\n');
                promptIn.value = cfg.prompt || '';
            }
        } else {
            titleEl.textContent = 'Self-Host Your VM';
            submitBtn.textContent = 'Add Self-Hosted VM';
            [nameIn, pathIn, locationIn, iconIn, catIn, descIn, passIn, rulesIn, promptIn].forEach(i => i.value = '');
            pathIn.disabled = false;
            manualPwIn.checked = false;
        }

        advFields.style.display = vmData ? 'flex' : 'none';
        if (errorContainer) {
            errorContainer.style.display = 'none';
            errorContainer.textContent = '';
        }

        advToggle.onclick = () => {
            advFields.style.display = advFields.style.display === 'none' ? 'flex' : 'none';
        };

        overlay.style.display = 'flex';

        cancelBtn.onclick = () => overlay.style.display = 'none';
        submitBtn.onclick = async () => {
            if (errorContainer) {
                errorContainer.style.display = 'none';
                errorContainer.textContent = '';
            }
            const name = nameIn.value.trim();
            const pathRaw = pathIn.value.trim();
            const icon = iconIn.value.trim();
            const categories = catIn.value.split(',').map(s => s.trim()).filter(s => s);
            const description = descIn.value.trim();

            if (!name || !pathRaw || !locationIn.value || !icon || categories.length === 0) {
                if (window.showNotification) window.showNotification("Please fill in all required fields marked with *", "error");
                return;
            }
            
            if (name.length > 20 || pathRaw.length > 20) {
                if (window.showNotification) window.showNotification("Name and Path must be 20 characters or less.", "error");
                return;
            }

            if (description.length > 100) {
                if (window.showNotification) window.showNotification("Description must be 100 characters or less.", "error");
                return;
            }

            const path = pathRaw.startsWith('/') ? pathRaw : '/' + pathRaw;
            let locationVal = locationIn.value.trim();
            let host = locationVal;
            let wsPath = '';
            
            try {
                const hasProtocol = locationVal.includes('://');
                const urlStr = hasProtocol ? locationVal : 'wss://' + locationVal;
                const url = new URL(urlStr);
                host = (url.protocol || 'wss:') + '//' + url.host;
                wsPath = url.pathname;
                if (url.search) wsPath += url.search;
                if (wsPath === '/') wsPath = '';
            } catch(e) {
                if (locationVal.includes('/')) {
                    const idx = locationVal.indexOf('/');
                    host = locationVal.substring(0, idx);
                    wsPath = locationVal.substring(idx);
                }
            }

            const payload = {
                name,
                path,
                ip: host,
                icon,
                categories,
                description,
                wsPath,
                websocket: true,
                password: passIn.value.trim(),
                manualPassword: manualPwIn.checked,
                rules: rulesIn.value.split('\n').map(s => s.trim()).filter(s => s),
                prompt: promptIn.value.trim()
            };
            
            if (vmData) {
                payload.renew = true; // Signal update/renewal to backend
            }

            submitBtn.disabled = true;
            submitBtn.textContent = "...";

            try {
                const params = new URLSearchParams();
                for (const [key, val] of Object.entries(payload)) {
                    params.append(key, typeof val === 'object' ? JSON.stringify(val) : val);
                }
                const url = window.apiSegment + '/selfhosted?' + params.toString();
                const response = await fetch(url);

                if (!response.ok) {
                    const txt = await response.text();
                    if (response.status === 429) {
                        throw new Error("Rate Limit: Cooldown active or you have reached the limit of 3 self-hosted VMs.");
                    }
                    if (response.status === 402) {
                        throw new Error("Connectivity Failed: The server must be able to connect to your VNC endpoint. Check your tunnel/port.");
                    }
                    throw new Error(txt || "Error adding VM.");
                }

                showNotification("Self-hosted VM added successfully!", "success");
                overlay.style.display = 'none';
                refreshVMList();
            } catch (err) {
                if (errorContainer) {
                    errorContainer.textContent = err.message;
                    errorContainer.style.display = 'block';
                    modal.scrollTop = 0;
                } else if (window.showNotification) {
                    window.showNotification(err.message, "error");
                }
            } finally {
                submitBtn.disabled = false;
                submitBtn.textContent = "Add Self-Hosted VM";
            }
        };
      }

      async function openEditVmModal(vmData) {
          const overlay = document.getElementById('edit-vm-overlay');
          const nameIn = document.getElementById('edit-vm-name');
          const pathIn = document.getElementById('edit-vm-target-path');
          const ipIn = document.getElementById('edit-vm-ip');
          const websocketIn = document.getElementById('edit-vm-websocket');
          const iconIn = document.getElementById('edit-vm-icon');
          const portIn = document.getElementById('edit-vm-port');
          const thumbIn = document.getElementById('edit-vm-thumbnail');
          const descIn = document.getElementById('edit-vm-desc');
          const mainCatIn = document.getElementById('edit-vm-main-cat');
          const extraCatsIn = document.getElementById('edit-vm-extra-cats');
          const rulesIn = document.getElementById('edit-vm-rules');
          
          const isPrivateServerIn = document.getElementById('edit-vm-is-private-server');
          const onlineIn = document.getElementById('edit-vm-online');
          const privateIn = document.getElementById('edit-vm-private');
          const hiddenIn = document.getElementById('edit-vm-hidden');
          const sponsoredIn = document.getElementById('edit-vm-sponsored');
          const alwaysRulesIn = document.getElementById('edit-vm-always-rules');
          const manualPwIn = document.getElementById('edit-vm-manual-pw');
          
          const passwordIn = document.getElementById('edit-vm-password');
          const rulesTimeoutIn = document.getElementById('edit-vm-rules-timeout');
          const embedIn = document.getElementById('edit-vm-embed');
          const promptIn = document.getElementById('edit-vm-prompt');
          const apiTokenIn = document.getElementById('edit-vm-api-token');

          const extrasIn = document.getElementById('edit-vm-extras');
          const controlsList = document.getElementById('edit-vm-controls-list');
          const addControlBtn = document.getElementById('add-vm-control-btn');
          const advToggle = document.getElementById('toggle-advanced-extras');
          const advContainer = document.getElementById('advanced-extras-container');

          const cancelBtn = document.getElementById('edit-vm-cancel');
          const saveBtn = document.getElementById('edit-vm-save');

          // STRICTLY USE UNFILTERED MODERATOR DATA FOR ACCURACY
          const isNew = vmData.code === 'new';
          const path = isNew ? '' : '/' + vmData.code;
          let modVmInfo = isNew ? { extras: {} } : window.modResponseData?.PORT_MAP?.[path];
          
          if (!isNew && !modVmInfo) {
              if (window.multiplayerCursors && typeof window.multiplayerCursors.refreshModeratorData === 'function') {
                  if(window.showNotification) window.showNotification("Fetching fresh moderator data...", "info");
                  try {
                      await window.multiplayerCursors.refreshModeratorData();
                      modVmInfo = window.modResponseData?.PORT_MAP?.[path];
                  } catch (e) {
                      console.error("Failed to refresh mod data", e);
                  }
              }
          }

          if (!modVmInfo) {
              if (window.showNotification) window.showNotification("Accurate moderator data not available. Please ensure you are logged into the F8 panel.", "error");
              overlay.style.display = 'none';
              return;
          }

          document.querySelector('#edit-vm-modal h3').textContent = isNew ? 'Add New Port Mapping' : 'Edit VM Configuration';

          // Schema: Root Level = [port, name, icon, extras]
          nameIn.value = modVmInfo.name || '';
          iconIn.value = modVmInfo.icon || '';
          portIn.value = modVmInfo.port || 5900;

          const extras = modVmInfo.extras || {};
          pathIn.value = isNew ? '' : (extras.path || '');

          // Schema: extras = [ip, websocket, description, thumbnail, online, ...]
          ipIn.value = extras.ip || '';
          websocketIn.checked = !!extras.websocket;
          thumbIn.value = extras.thumbnail || '';
          descIn.value = extras.description || '';
          
          // Categorization logic for edit fields
          const mainCategoryKeys = ['windows', 'mac', 'linux', 'site'];
          const cats = Array.isArray(extras.categories) ? extras.categories.map(c => String(c).toLowerCase()) : [];
          
          isPrivateServerIn.checked = cats.includes('private server');
          
          const mainCat = cats.find(c => mainCategoryKeys.includes(c)) || '';
          const extraCats = cats.filter(c => c !== mainCat && c !== 'private server');
          
          mainCatIn.value = mainCat;
          extraCatsIn.value = extraCats.join(', ');

          rulesIn.value = Array.isArray(extras.rules) ? extras.rules.join('\n') : '';

          onlineIn.checked = !!extras.online;
          privateIn.checked = !!extras.private;
          hiddenIn.checked = !!extras.hidden;
          sponsoredIn.checked = !!extras.sponsored;
          alwaysRulesIn.checked = !!extras.alwaysReadRules;
          manualPwIn.checked = !!extras.manualPassword;

          passwordIn.value = extras.password || '';
          rulesTimeoutIn.value = extras.rulesTimeout || '';
          embedIn.value = extras.embed || '';
          promptIn.value = extras.prompt || '';
          apiTokenIn.value = extras.api_token || '';

          extrasIn.value = JSON.stringify(extras, null, 2);
          advContainer.style.display = 'none';

          // --- CONTROLS EDITOR LOGIC ---
          let localControls = { ...(extras.controls || {}) };
          
          const renderControlItem = (key, data) => {
              const div = document.createElement('div');
              div.className = 'edit-control-row';
              div.style.cssText = 'background: rgba(0,0,0,0.3); border: 1px solid rgba(255,255,255,0.1); border-radius: 6px; padding: 10px; display: flex; flex-direction: column; gap: 8px; position: relative;';
              
              const delBtn = document.createElement('button');
              delBtn.innerHTML = '&times;';
              delBtn.style.cssText = 'position: absolute; top: 2px; right: 5px; background: none; border: none; color: #ff6b6b; cursor: pointer; font-size: 20px; font-weight: bold; padding: 0;';
              delBtn.title = "Remove this control";
              delBtn.onclick = (e) => {
                  e.preventDefault();
                  delete localControls[key];
                  refreshControlsList();
              };
              div.appendChild(delBtn);

              div.innerHTML += `
                  <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 10px;">
                      <div class="edit-vm-field">
                          <label>Action (ID)</label>
                          <input type="text" class="ctrl-key" value="${sanitize(key)}" placeholder="e.g. restore">
                      </div>
                      <div class="edit-vm-field">
                          <label>Label</label>
                          <input type="text" class="ctrl-name" value="${sanitize(data.name || '')}" placeholder="e.g. Restore Snapshot">
                      </div>
                  </div>

                  <div style="background: rgba(0,0,0,0.2); padding: 8px; border-radius: 4px; border: 1px solid rgba(255,255,255,0.05); margin: 4px 0;">
                    <div style="font-size: 10px; font-weight: bold; color: #8fb3ff; margin-bottom: 6px; text-transform: uppercase;">Private Request (Hidden from users)</div>
                    <div class="edit-vm-field" style="margin-bottom: 6px;">
                        <label>URL</label>
                        <input type="text" class="ctrl-req-to" value="${sanitize(data.request?.to || '')}" placeholder="https://...">
                    </div>
                    <div style="display: grid; grid-template-columns: 1fr 1fr; gap: 8px;">
                         <div class="edit-vm-field">
                            <label>Method</label>
                            <select class="ctrl-req-type" style="background: #0a0e1a; border: 1px solid rgba(120,150,200,0.3); color: #fff; border-radius: 4px; padding: 4px; font-size: 11px;">
                                <option value="GET" ${data.request?.type==='GET'?'selected':''}>GET</option>
                                <option value="POST" ${data.request?.type==='POST'?'selected':''}>POST</option>
                                <option value="PUT" ${data.request?.type==='PUT'?'selected':''}>PUT</option>
                                <option value="DELETE" ${data.request?.type==='DELETE'?'selected':''}>DELETE</option>
                            </select>
                         </div>
                         <div class="edit-vm-field" style="display:flex; flex-direction:row; align-items:center; gap:8px; height:100%; padding-top:12px;">
                            <label style="font-size: 10px; cursor: pointer; display: flex; align-items: center; gap: 3px;"><input type="checkbox" class="ctrl-req-wait" ${data.request?.waitUntilFinished?'checked':''}> Wait</label>
                            <label style="font-size: 10px; cursor: pointer; display: flex; align-items: center; gap: 3px;"><input type="checkbox" class="ctrl-req-headers" ${data.request?.headers?'checked':''}> Auth</label>
                         </div>
                    </div>
                    <div class="edit-vm-field" style="margin-top: 6px;">
                        <label>Headers (JSON)</label>
                        <input type="text" class="ctrl-req-custom" value='${sanitize(JSON.stringify(data.request?.customHeaders || {}))}' placeholder='{"key": "val"}'>
                    </div>
                  </div>

                  <div style="display: flex; align-items: center; gap: 10px;">
                      <label style="font-size: 11px; display: flex; align-items: center; gap: 6px; cursor: pointer; color: #add8e6;">
                          <input type="checkbox" class="ctrl-vote" ${data.vote?.requiresVote ? 'checked' : ''}> Enable Voting
                      </label>
                  </div>
                  <div class="ctrl-vote-fields" style="display: ${data.vote?.requiresVote ? 'grid' : 'none'}; grid-template-columns: 1fr 1fr; gap: 10px; border-top: 1px dashed rgba(255,255,255,0.1); padding-top: 10px;">
                      <div class="edit-vm-field"><label>% to Pass</label><input type="number" class="ctrl-vote-p" value="${data.vote?.percentage || 50}" min="1" max="100"></div>
                      <div class="edit-vm-field"><label>Cooldown</label><input type="text" class="ctrl-vote-c" value="${data.vote?.cooldown || '8m'}" placeholder="8m"></div>
                      <div class="edit-vm-field" style="grid-column: span 2;"><label>Success Message</label><input type="text" class="ctrl-vote-s" value="${sanitize(data.vote?.successText || '')}" placeholder="Message on success"></div>
                  </div>
              `;

              const voteCheck = div.querySelector('.ctrl-vote');
              const voteFields = div.querySelector('.ctrl-vote-fields');
              voteCheck.onchange = () => {
                  voteFields.style.display = voteCheck.checked ? 'grid' : 'none';
              };

              return div;
          };

          const refreshControlsList = () => {
              controlsList.innerHTML = '';
              Object.entries(localControls).forEach(([k, v]) => {
                  controlsList.appendChild(renderControlItem(k, v));
              });
              if (Object.keys(localControls).length === 0) {
                  controlsList.innerHTML = '<div style="font-size:11px; opacity:0.5; text-align:center; padding:10px;">No custom controls added.</div>';
              }
          };

          addControlBtn.onclick = (e) => {
              e.preventDefault();
              const newKey = 'action_' + Math.random().toString(36).substr(2, 5);
              localControls[newKey] = { name: 'New Action', type: 'button', vote: { requiresVote: false } };
              refreshControlsList();
          };

          refreshControlsList();

          // Toggle internal path visibility based on websocket VNC
          const pathField = document.getElementById('edit-vm-path-field');
          const updatePathVisibility = () => {
              pathField.style.display = websocketIn.checked ? 'flex' : 'none';
          };
          websocketIn.onchange = updatePathVisibility;
          updatePathVisibility();

          advToggle.onclick = () => {
              advContainer.style.display = advContainer.style.display === 'none' ? 'block' : 'none';
          };

          overlay.style.display = 'flex';

          cancelBtn.onclick = () => overlay.style.display = 'none';
          saveBtn.onclick = async () => {
              try {
                  // Re-parse current raw extras if visible, otherwise use form fields
                  let finalExtras;
                  if (advContainer.style.display === 'block') {
                      finalExtras = JSON.parse(extrasIn.value);
                  } else {
                      finalExtras = { ...extras };
                      finalExtras.ip = ipIn.value;
                      finalExtras.path = pathIn.value;
                      finalExtras.websocket = websocketIn.checked;
                      finalExtras.description = descIn.value;
                      finalExtras.thumbnail = thumbIn.value;
                      finalExtras.online = onlineIn.checked;
                      finalExtras.private = privateIn.checked;
                      finalExtras.hidden = hiddenIn.checked;
                      finalExtras.sponsored = sponsoredIn.checked;
                      finalExtras.alwaysReadRules = alwaysRulesIn.checked;
                      finalExtras.manualPassword = manualPwIn.checked;
                      
                      finalExtras.password = passwordIn.value;
                      finalExtras.rulesTimeout = rulesTimeoutIn.value;
                      finalExtras.embed = embedIn.value;
                      finalExtras.prompt = promptIn.value;
                      finalExtras.api_token = apiTokenIn.value;

                      // Combine main category and extra categories
                      const catsList = extraCatsIn.value.split(',').map(s => s.trim().toLowerCase()).filter(s => s);
                      if (mainCatIn.value) {
                          catsList.unshift(mainCatIn.value);
                      }
                      if (isPrivateServerIn.checked) {
                          catsList.push('private server');
                      }
                      finalExtras.categories = [...new Set(catsList)]; // Dedupe
                      
                      finalExtras.rules = rulesIn.value.split('\n').map(s => s.trim()).filter(s => s);

                      // Collect VM Controls from the dynamic list
                      const updatedControls = {};
                      controlsList.querySelectorAll('.edit-control-row').forEach(row => {
                          const keyInput = row.querySelector('.ctrl-key');
                          const key = keyInput.value.trim().replace(/\s+/g, '_');
                          if (!key) return;
                          
                          const name = row.querySelector('.ctrl-name').value.trim();
                          const requiresVote = row.querySelector('.ctrl-vote').checked;
                          
                          const ctrlData = { name, type: 'button' };
                          
                          // Collect Request Data
                          const reqTo = row.querySelector('.ctrl-req-to').value.trim();
                          if (reqTo) {
                              let customHeaders = {};
                              try {
                                  customHeaders = JSON.parse(row.querySelector('.ctrl-req-custom').value || '{}');
                              } catch(e) {}
                              
                              ctrlData.request = {
                                  to: reqTo,
                                  type: row.querySelector('.ctrl-req-type').value,
                                  waitUntilFinished: row.querySelector('.ctrl-req-wait').checked,
                                  headers: row.querySelector('.ctrl-req-headers').checked,
                                  customHeaders: customHeaders
                              };
                          }

                          if (requiresVote) {
                              ctrlData.vote = {
                                  requiresVote: true,
                                  percentage: parseInt(row.querySelector('.ctrl-vote-p').value) || 50,
                                  cooldown: row.querySelector('.ctrl-vote-c').value.trim() || '8m',
                                  successText: row.querySelector('.ctrl-vote-s').value.trim() || 'Action triggered.',
                                  failedText: 'Action failed to trigger.'
                              };
                          } else {
                              ctrlData.vote = { requiresVote: false };
                          }
                          updatedControls[key] = ctrlData;
                      });
                      finalExtras.controls = updatedControls;
                  }

                  const finalPath = isNew ? (pathIn.value.startsWith('/') ? pathIn.value : '/' + pathIn.value) : path;

                  await sendModRequest({
                      [isNew ? 'addPortMap' : 'editPortMap']: {
                          path: finalPath,
                          name: nameIn.value,
                          icon: iconIn.value,
                          port: parseInt(portIn.value, 10),
                          extras: finalExtras
                      }
                  });
                  overlay.style.display = 'none';
                  refreshVMList();
              } catch(e) {
                  if (window.showNotification) window.showNotification("Error saving: " + e.message, "error");
              }
          };
      }