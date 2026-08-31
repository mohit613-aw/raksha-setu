// ==============================================================================
// Raksha Setu — Frontend Controller & Real-Time Engine
// ==============================================================================

// Adaptive API Base: Use localhost:8000 for local separate dev server, or current origin on cloud production
const API_BASE = (window.location.port === "5500" || window.location.port === "3000" || window.location.port === "5173")
    ? "http://127.0.0.1:8000"
    : (window.API_BASE || window.location.origin);

// Global State
let map = null;
let overviewMap = null;
let disastersLayer = null;
let sheltersLayer = null;
let missingPersonsLayer = null;
let heatLayer = null;
let overviewDisastersLayer = null;
let overviewSheltersLayer = null;
let overviewMissingPersonsLayer = null;

let isOffline = !navigator.onLine;
let activeTab = "overview";
let currentViewMode = "admin";
let mapVisualMode = "both"; // "both", "heat", "markers"
let sseEventSource = null;

// Authentication State (Category 1)
let currentUser = null;
let authToken = localStorage.getItem("access_token") || localStorage.getItem("disasterhub_auth_token") || null;

// Data Store
let currentDisasters = [];
let currentShelters = [];
let currentResources = [];
let currentRequests = [];
let currentAlerts = [];
let currentHeatmapPoints = [];
let currentCommLogs = [];

// ==================== TOAST NOTIFICATIONS ====================
function showToast(message, type = "success") {
    const toast = document.getElementById("toast");
    if (!toast) return;

    const bg = type === "success" ? "bg-emerald-600" :
               type === "warning" ? "bg-amber-600" :
               type === "info"    ? "bg-blue-600" : "bg-red-600";

    toast.innerHTML = `
        <div class="flex items-center gap-2.5">
            <span>${type === "success" ? "✓" : type === "warning" ? "⚠️" : type === "info" ? "ℹ️" : "✕"}</span>
            <span>${message}</span>
        </div>
    `;
    toast.className = `fixed bottom-6 right-6 z-50 px-5 py-3.5 rounded-2xl shadow-2xl text-white font-semibold text-xs md:text-sm transition-all duration-300 transform ${bg}`;
    toast.classList.remove("hidden", "opacity-0", "translate-y-4");

    setTimeout(() => {
        toast.classList.add("opacity-0", "translate-y-4");
        setTimeout(() => toast.classList.add("hidden"), 300);
    }, 3500);
}

// ==================== REAL-TIME SSE EVENT STREAM ====================
function initSSE() {
    if (typeof EventSource === "undefined") {
        console.warn("SSE not supported by browser, fallback to polling.");
        return;
    }

    const pill = document.getElementById("sse-status-pill");
    
    try {
        if (sseEventSource) sseEventSource.close();
        sseEventSource = new EventSource(`${API_BASE}/events/stream`);

        sseEventSource.onopen = () => {
            if (pill) {
                pill.className = "text-[9px] font-black px-1.5 py-0.5 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 uppercase tracking-widest flex items-center gap-1";
                pill.innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span><span>Live SSE</span>';
            }
        };

        sseEventSource.onmessage = (event) => {
            try {
                const data = JSON.parse(event.data);
                if (data.event === "connected" || data.event === "heartbeat" || data.event === "ping") return;

                console.log("[SSE Event Received]:", data);

                if (data.event === "notification") {
                    if (currentUser && data.data && data.data.user_id === currentUser.id) {
                        showToast(data.data.title || "New notification received", "info");
                        fetchUnreadNotificationCount();
                        const panel = document.getElementById("notification-panel");
                        if (panel && !panel.classList.contains("hidden")) {
                            loadNotifications();
                        }
                    }
                    return;
                }

                if (data.event === "incident_reported") {
                    const isAuthOrAdmin = currentUser && ["AUTHORITY_VERIFIED", "ADMIN"].includes(currentUser.role);
                    if (isAuthOrAdmin) {
                        showToast(`🚨 NEW EMERGENCY DISPATCH: Report #${data.data.id} (${data.data.type || data.data.category}) from ${data.data.reporter_name || 'Citizen'} in ${data.data.location}`, "warning");
                        fetchUnreadNotificationCount();
                    } else {
                        showToast(`🚨 Incident Reported: ${data.data.type || 'Emergency'} in ${data.data.location}`, "info");
                    }
                    loadOverview();
                    if (map) loadMapData();
                    if (activeTab === "disasters") loadDisasters();
                    if (activeTab === "verification") loadVerificationQueue();
                    if (activeTab === "authority-dashboard") loadAuthorityDashboard();
                    return;
                }

                showToast(`Live update received: ${data.event.replace('_', ' ').toUpperCase()}`, "info");

                // Silently refresh current view data
                loadOverview();
                if (activeTab === "map") loadMapData();
                if (activeTab === "disasters") loadDisasters();
                if (activeTab === "alerts") loadAlerts();
                if (activeTab === "telephony") loadCommunicationLogs();
                if (activeTab === "authority-dashboard") loadAuthorityDashboard();
                if (activeTab === "verification") loadVerificationQueue();

            } catch (e) {}
        };

        sseEventSource.onerror = () => {
            if (pill) {
                pill.className = "text-[9px] font-black px-1.5 py-0.5 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30 uppercase tracking-widest flex items-center gap-1";
                pill.innerHTML = '<span class="w-1.5 h-1.5 rounded-full bg-amber-400"></span><span>Reconnecting</span>';
            }
        };
    } catch (err) {
        console.warn("SSE init failed:", err);
    }
}

// ==================== OFFLINE MANAGER & QUEUE ====================
const OfflineManager = {
    QUEUE_KEY: "disasterhub_offline_queue",
    CACHE_PREFIX: "disasterhub_cache_",

    init() {
        window.addEventListener("online", () => this.handleNetworkChange(true));
        window.addEventListener("offline", () => this.handleNetworkChange(false));
        this.updateNetworkUI(navigator.onLine);
        this.updateQueueUI();
    },

    handleNetworkChange(online) {
        isOffline = !online;
        this.updateNetworkUI(online);
        if (online) {
            showToast("Internet connection restored! Syncing queued records...", "success");
            this.syncQueue();
            initSSE();
        } else {
            showToast("Offline mode: Actions will be queued locally.", "warning");
        }
    },

    updateNetworkUI(online) {
        const banner = document.getElementById("offline-banner");
        if (banner) banner.classList.toggle("hidden", online);
    },

    getQueue() {
        try {
            return JSON.parse(localStorage.getItem(this.QUEUE_KEY) || "[]");
        } catch {
            return [];
        }
    },

    addToQueue(action) {
        const queue = this.getQueue();
        queue.push({
            id: Date.now(),
            timestamp: new Date().toISOString(),
            ...action
        });
        localStorage.setItem(this.QUEUE_KEY, JSON.stringify(queue));
        this.updateQueueUI();
        showToast(`Saved to offline queue (${action.label})! Will auto-sync when online.`, "warning");
    },

    updateQueueUI() {
        const queue = this.getQueue();
        const badge = document.getElementById("offline-queue-badge");
        const syncCard = document.getElementById("sync-card");
        const syncCount = document.getElementById("sync-count");

        if (badge) badge.textContent = `${queue.length} Pending`;
        if (syncCount) syncCount.textContent = `${queue.length}`;
        if (syncCard) syncCard.classList.toggle("hidden", queue.length === 0);
    },

    async syncQueue() {
        const queue = this.getQueue();
        if (queue.length === 0) {
            showToast("Offline queue is clean.", "info");
            return;
        }

        let syncedCount = 0;
        const remainingQueue = [];

        for (const item of queue) {
            try {
                const res = await fetch(item.url, {
                    method: item.method,
                    headers: { "Content-Type": "application/json" },
                    body: JSON.stringify(item.payload)
                });

                if (res.ok) {
                    syncedCount++;
                } else {
                    remainingQueue.push(item);
                }
            } catch (err) {
                remainingQueue.push(item);
            }
        }

        localStorage.setItem(this.QUEUE_KEY, JSON.stringify(remainingQueue));
        this.updateQueueUI();

        if (syncedCount > 0) {
            showToast(`Synchronized ${syncedCount} queued action(s) with central server!`, "success");
            loadOverview();
        }
    },

    setCache(key, data) {
        try {
            localStorage.setItem(this.CACHE_PREFIX + key, JSON.stringify(data));
        } catch (e) {}
    },

    getCache(key) {
        try {
            return JSON.parse(localStorage.getItem(this.CACHE_PREFIX + key) || "null");
        } catch {
            return null;
        }
    }
};

function syncOfflineQueue() {
    OfflineManager.syncQueue();
}

// ==================== LIVE IST CLOCK ====================
function startISTClock() {
    const clockEl = document.getElementById("ist-clock");
    if (!clockEl) return;

    function update() {
        const now = new Date();
        const istTime = now.toLocaleTimeString("en-IN", {
            timeZone: "Asia/Kolkata",
            hour12: true,
            hour: "2-digit",
            minute: "2-digit",
            second: "2-digit"
        });
        clockEl.textContent = `IST ${istTime}`;
    }
    update();
    setInterval(update, 1000);
}

// ==================== VIEW MODE SWITCHER ====================
function setViewMode(mode) {
    currentViewMode = mode;
    const btnAdmin = document.getElementById("view-mode-admin");
    const btnCitizen = document.getElementById("view-mode-citizen");

    if (mode === "citizen") {
        if (btnCitizen) btnCitizen.className = "px-3 py-1 rounded-lg bg-orange-600 text-white font-bold transition shadow-sm";
        if (btnAdmin) btnAdmin.className = "px-3 py-1 rounded-lg text-slate-400 hover:text-white transition";
        switchTab("sos");
        showToast("Switched to Citizen & Public Safety View", "info");
    } else {
        if (btnAdmin) btnAdmin.className = "px-3 py-1 rounded-lg bg-blue-600 text-white font-bold transition shadow-sm";
        if (btnCitizen) btnCitizen.className = "px-3 py-1 rounded-lg text-slate-400 hover:text-white transition";
        switchTab("overview");
        showToast("Switched to Incident Command View", "info");
    }
}

// ==================== TAB NAVIGATION ====================
function switchTab(tabId) {
    activeTab = tabId;
    const tabs = ["overview", "sos", "map", "disasters", "verification", "shelters", "resources", "alerts", "telephony", "admin-authorities", "missing-persons", "user-dashboard", "authority-dashboard"];

    tabs.forEach(t => {
        const el = document.getElementById(`tab-${t}`);
        const navBtn = document.getElementById(`nav-${t}`);

        if (el) el.classList.toggle("hidden", t !== tabId);

        if (navBtn) {
            if (t === tabId) {
                navBtn.className = "w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl font-bold text-xs transition bg-blue-600 text-white shadow-md shadow-blue-500/20";
                const svg = navBtn.querySelector("svg");
                if (svg) svg.className = "w-4 h-4 shrink-0 text-white";
            } else {
                if (t === "sos") {
                    navBtn.className = "w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl font-bold text-xs text-red-600 bg-red-50 hover:bg-red-100 transition border border-red-100";
                } else {
                    navBtn.className = "w-full flex items-center gap-3 px-3.5 py-2.5 rounded-xl font-semibold text-xs text-slate-600 hover:bg-slate-100 hover:text-slate-900 transition";
                }
            }
        }
    });

    const sidebar = document.getElementById("app-sidebar");
    if (sidebar && window.innerWidth < 768) {
        sidebar.classList.add("-translate-x-full");
    }

    if (tabId === "overview") {
        loadOverview();
        initOverviewMap();
        [150, 400, 800].forEach(d => setTimeout(() => { if (overviewMap) overviewMap.invalidateSize(); }, d));
    }
    if (tabId === "map") {
        initMap();
        loadMapData();
        [150, 400, 800].forEach(d => setTimeout(() => { if (map) map.invalidateSize(); }, d));
    }
    if (tabId === "disasters") loadDisasters();
    if (tabId === "verification") loadVerificationQueue();
    if (tabId === "shelters") loadShelters();
    if (tabId === "resources") loadResources();
    if (tabId === "alerts") {
        loadAlerts();
        fetchIMDStatus();
    }
    if (tabId === "telephony") loadCommunicationLogs();
    if (tabId === "admin-authorities") loadAdminAuthorityApplications();
    if (tabId === "missing-persons") loadMissingPersons();
    if (tabId === "user-dashboard") loadUserDashboard();
    if (tabId === "authority-dashboard") loadAuthorityDashboard();
}

function toggleMobileSidebar() {
    const sidebar = document.getElementById("app-sidebar");
    if (sidebar) sidebar.classList.toggle("-translate-x-full");
}

// ==================== MODAL HELPERS ====================
function openModal(id) {
    const m = document.getElementById(id);
    if (m) {
        m.classList.remove("hidden");
        document.body.classList.add("modal-open");
        if (id === "modal-user-profile") {
            loadProfileUserReports();
        }
    }
}

async function loadProfileUserReports() {
    const listContainer = document.getElementById("modal-user-reports-list");
    const countBadge = document.getElementById("modal-user-reports-count");
    if (!listContainer) return;

    try {
        const res = await fetch(`${API_BASE}/reports/`);
        if (!res.ok) throw new Error("Failed to fetch reports");
        const allReports = await res.json();

        let userReports = allReports;
        if (currentUser && currentUser.phone_number) {
            const cleanPhone = currentUser.phone_number.replace(/\D/g, "");
            const filtered = allReports.filter(r => (r.reporter_phone && r.reporter_phone.includes(cleanPhone)) || (r.reporter_name && r.reporter_name.toLowerCase().includes((currentUser.name || "").toLowerCase())));
            if (filtered.length > 0) userReports = filtered;
        }

        if (countBadge) countBadge.textContent = `${userReports.length} Reports`;

        if (userReports.length === 0) {
            listContainer.innerHTML = `<div class="p-4 text-center text-slate-400 text-xs bg-slate-50 rounded-2xl border border-slate-100">No emergency reports submitted yet.</div>`;
            return;
        }

        listContainer.innerHTML = userReports.map(r => {
            const sign = getDisasterVisualSign(r.category || r.type, r.severity || "High");
            const photoHtml = r.image_url ? `<img src="${r.image_url.startsWith('http') ? r.image_url : API_BASE + r.image_url}" class="w-12 h-12 rounded-xl object-cover border border-slate-200 shrink-0">` : '';
            return `
                <div class="p-3 bg-slate-50 rounded-2xl border border-slate-200 text-xs flex gap-3 items-start">
                    ${photoHtml}
                    <div class="flex-1 min-w-0 space-y-1">
                        <div class="flex items-center justify-between gap-1">
                            <span class="font-extrabold text-slate-900 text-xs flex items-center gap-1 truncate">
                                <span>${sign.icon}</span> <span>${r.category || r.type || "Incident Report"}</span>
                            </span>
                            <span class="text-[9px] font-black px-2 py-0.5 rounded-full ${r.status === 'Resolved' ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-800'} uppercase shrink-0">${r.status || 'Pending'}</span>
                        </div>
                        <p class="text-[11px] text-slate-700 font-bold truncate">📍 ${r.location || 'Location Not Specified'}</p>
                        <p class="text-[11px] text-slate-600 line-clamp-2">${r.description || 'No description provided.'}</p>
                        <div class="flex items-center justify-between text-[10px] text-slate-400 font-mono pt-1">
                            <span>🆘 ${r.relief_type_required || 'General Help'}</span>
                            <span>${r.created_at ? new Date(r.created_at).toLocaleDateString("en-IN") : 'Today'}</span>
                        </div>
                    </div>
                </div>
            `;
        }).join("");

    } catch (err) {
        console.warn("[Profile] Could not load user reports:", err);
        if (listContainer) {
            listContainer.innerHTML = `<div class="p-3 text-center text-slate-400 text-xs">Could not load reports.</div>`;
        }
    }
}

function closeModal(id) {
    const m = document.getElementById(id);
    if (m) {
        m.classList.add("hidden");
        // Only remove lock if no other modals are open
        const anyOpen = document.querySelectorAll(".modal-backdrop:not(.hidden)").length > 0;
        if (!anyOpen) document.body.classList.remove("modal-open");
    }
}

window.addEventListener("keydown", (e) => {
    if (e.key === "Escape") {
        document.querySelectorAll(".modal-backdrop").forEach(m => m.classList.add("hidden"));
        document.body.classList.remove("modal-open");
    }
    if (e.key === "/" && document.activeElement.tagName !== "INPUT" && document.activeElement.tagName !== "TEXTAREA") {
        e.preventDefault();
        const searchInput = document.getElementById("global-search");
        if (searchInput) searchInput.focus();
    }
});

function useCurrentLocation(latId, lngId, addressId) {
    if (!navigator.geolocation) {
        showToast("Geolocation is not supported by your browser.", "warning");
        return;
    }
    showToast("Detecting GPS position...", "info");
    navigator.geolocation.getCurrentPosition(
        async (pos) => {
            const lat = pos.coords.latitude.toFixed(6);
            const lng = pos.coords.longitude.toFixed(6);
            const latEl = document.getElementById(latId);
            const lngEl = document.getElementById(lngId);
            if (latEl) latEl.value = lat;
            if (lngEl) lngEl.value = lng;

            // Reverse geocode the coordinates using Nominatim
            if (addressId) {
                try {
                    const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=14&addressdetails=1`, {
                        headers: { "Accept-Language": "en" }
                    });
                    const data = await res.json();
                    const addr = data.address || {};
                    const parts = [
                        addr.road || addr.hamlet || addr.neighbourhood,
                        addr.village || addr.suburb || addr.town || addr.city_district,
                        addr.city || addr.county || addr.district,
                        addr.state,
                        addr.country
                    ].filter(Boolean);
                    const addressText = parts.join(", ");
                    const addrEl = document.getElementById(addressId);
                    if (addrEl && addressText) {
                        addrEl.value = addressText;
                        showToast(`📍 Location detected: ${parts.slice(0, 3).join(", ")}`, "success");
                    } else {
                        showToast(`GPS Position Set: ${lat}, ${lng}`, "success");
                    }
                } catch {
                    showToast(`GPS Set: ${lat}, ${lng}`, "success");
                }
            } else {
                showToast(`GPS Position Set: ${lat}, ${lng}`, "success");
            }
        },
        (err) => {
            showToast("Could not access GPS. Please enter location manually.", "warning");
        },
        { enableHighAccuracy: true, timeout: 10000 }
    );
}

// ==================== REPORT MODAL HELPERS ====================

async function autoDetectReportLocation() {
    const btn = document.getElementById("btn-auto-detect-location");
    const btnText = document.getElementById("auto-detect-btn-text");
    const coordsDisplay = document.getElementById("gps-coords-display");
    const coordsText = document.getElementById("gps-coords-text");

    if (!navigator.geolocation) {
        showToast("GPS not supported by this browser.", "warning");
        return;
    }

    if (btn) btn.disabled = true;
    if (btnText) btnText.textContent = "⏳ Detecting GPS...";

    navigator.geolocation.getCurrentPosition(
        async (pos) => {
            const lat = pos.coords.latitude.toFixed(6);
            const lng = pos.coords.longitude.toFixed(6);

            document.getElementById("disaster-lat").value = lat;
            document.getElementById("disaster-lng").value = lng;

            if (coordsDisplay) coordsDisplay.classList.remove("hidden");
            if (coordsText) coordsText.textContent = `${lat}, ${lng}`;

            if (btn) btn.disabled = false;
            if (btnText) btnText.textContent = "✅ GPS Detected — Re-Detect";

            try {
                const res = await fetch(`https://nominatim.openstreetmap.org/reverse?format=jsonv2&lat=${lat}&lon=${lng}&zoom=14&addressdetails=1`, {
                    headers: { "Accept-Language": "en" }
                });
                const data = await res.json();
                const addr = data.address || {};
                const parts = [
                    addr.road || addr.hamlet || addr.neighbourhood,
                    addr.village || addr.suburb || addr.town || addr.city_district,
                    addr.city || addr.county || addr.district,
                    addr.state,
                    addr.country
                ].filter(Boolean);
                const addressText = parts.join(", ");
                if (addressText) {
                    document.getElementById("disaster-location").value = addressText;
                    showToast(`📍 Location auto-filled: ${parts.slice(0, 3).join(", ")}`, "success");
                }
            } catch {
                showToast(`GPS coordinates set: ${lat}, ${lng}`, "success");
            }

            validateReportForm();
        },
        (err) => {
            if (btn) btn.disabled = false;
            if (btnText) btnText.textContent = "📍 Auto-Detect My GPS Location";
            showToast("GPS access denied. Please enter location manually.", "warning");
        },
        { enableHighAccuracy: true, timeout: 12000 }
    );
}

function validateReportForm() {
    const name = document.getElementById("report-reporter-name")?.value.trim();
    const phone = document.getElementById("report-reporter-phone")?.value.trim();
    const location = document.getElementById("disaster-location")?.value.trim();
    const description = document.getElementById("disaster-description")?.value.trim();
    const bar = document.getElementById("form-validation-bar");
    const phoneMsg = document.getElementById("phone-validation-msg");

    // Phone validation
    const phoneValid = /^[6-9][0-9]{9}$/.test(phone);
    if (phoneMsg) {
        if (!phone) {
            phoneMsg.textContent = "Enter 10-digit mobile number";
            phoneMsg.className = "text-[10px] mt-1 text-slate-400";
        } else if (!phoneValid) {
            phoneMsg.textContent = "❌ Invalid number — must start with 6-9, 10 digits";
            phoneMsg.className = "text-[10px] mt-1 text-red-500 font-bold";
        } else {
            phoneMsg.textContent = "✅ Valid mobile number";
            phoneMsg.className = "text-[10px] mt-1 text-emerald-600 font-bold";
        }
    }

    const errors = [];
    if (!name) errors.push("Full name");
    if (!phoneValid) errors.push("Valid phone number");
    if (!location) errors.push("Location");
    if (!description || description.length < 20) errors.push("Description (min 20 chars)");

    const submitBtn = document.getElementById("btn-submit-report");

    if (errors.length > 0 && (name || phone || location || description)) {
        if (bar) {
            bar.className = "p-3 rounded-xl text-[11px] font-semibold bg-amber-50 text-amber-800 border border-amber-200";
            bar.textContent = `Missing required: ${errors.join(", ")}`;
            bar.classList.remove("hidden");
        }
    } else {
        if (bar) bar.classList.add("hidden");
    }
}

function updateDescCount(textarea) {
    const counter = document.getElementById("desc-char-count");
    if (counter) {
        const len = textarea.value.length;
        counter.textContent = `${len}/2000`;
        counter.className = len < 20 ? "text-[10px] font-mono text-red-400" : len > 1800 ? "text-[10px] font-mono text-amber-500" : "text-[10px] font-mono text-slate-400";
    }
}

function previewReportPhoto(input) {
    const file = input.files[0];
    if (!file) return;

    if (file.size > 10 * 1024 * 1024) {
        showToast("Image too large. Maximum size is 10MB.", "warning");
        input.value = "";
        return;
    }

    const reader = new FileReader();
    reader.onload = (e) => {
        const placeholder = document.getElementById("photo-drop-placeholder");
        const previewWrapper = document.getElementById("photo-preview-wrapper");
        const previewImg = document.getElementById("photo-preview-img");
        const previewName = document.getElementById("photo-preview-name");

        if (placeholder) placeholder.classList.add("hidden");
        if (previewWrapper) previewWrapper.classList.remove("hidden");
        if (previewImg) previewImg.src = e.target.result;
        if (previewName) previewName.textContent = file.name;
    };
    reader.readAsDataURL(file);
}

function handleImageDrop(event) {
    event.preventDefault();
    const dropZone = document.getElementById("photo-drop-zone");
    if (dropZone) {
        dropZone.classList.remove("border-red-500", "bg-red-50");
    }
    const file = event.dataTransfer?.files?.[0];
    if (!file) return;
    if (!file.type.startsWith("image/")) {
        showToast("Please drop an image file.", "warning");
        return;
    }
    const input = document.getElementById("report-image-file");
    if (input) {
        const dt = new DataTransfer();
        dt.items.add(file);
        input.files = dt.files;
        previewReportPhoto(input);
    }
}

function clearPhotoPreview(event) {
    if (event) event.stopPropagation();
    const input = document.getElementById("report-image-file");
    if (input) input.value = "";
    const placeholder = document.getElementById("photo-drop-placeholder");
    const previewWrapper = document.getElementById("photo-preview-wrapper");
    if (placeholder) placeholder.classList.remove("hidden");
    if (previewWrapper) previewWrapper.classList.add("hidden");
}


async function loadOverview() {
    // 1. Instant Render from Local Cache (0ms perceived load time!)
    const cachedD = OfflineManager.getCache("disasters");
    const cachedS = OfflineManager.getCache("shelters");
    const cachedR = OfflineManager.getCache("requests");
    const cachedA = OfflineManager.getCache("alerts");
    if (cachedD || cachedS || cachedR || cachedA) {
        currentDisasters = cachedD || [];
        currentShelters = cachedS || [];
        currentRequests = cachedR || [];
        currentAlerts = cachedA || [];
        renderOverviewStats(currentDisasters, currentShelters, currentRequests, currentAlerts, []);
        renderOverviewPanels(currentDisasters, currentShelters, currentRequests);
    }

    // 2. Background Revalidation (Parallel Network Fetch)
    try {
        const [disastersRes, sheltersRes, requestsRes, alertsRes, commRes] = await Promise.all([
            fetch(`${API_BASE}/disasters/`),
            fetch(`${API_BASE}/shelters/`),
            fetch(`${API_BASE}/resources/requests/`),
            fetch(`${API_BASE}/alerts/?active_only=true`),
            fetch(`${API_BASE}/communication/logs?limit=50`)
        ]);

        currentDisasters = await disastersRes.json();
        currentShelters = await sheltersRes.json();
        currentRequests = await requestsRes.json();
        currentAlerts = await alertsRes.json();
        currentCommLogs = await commRes.json();

        OfflineManager.setCache("disasters", currentDisasters);
        OfflineManager.setCache("shelters", currentShelters);
        OfflineManager.setCache("requests", currentRequests);
        OfflineManager.setCache("alerts", currentAlerts);

        renderOverviewStats(currentDisasters, currentShelters, currentRequests, currentAlerts, currentCommLogs);
        renderOverviewPanels(currentDisasters, currentShelters, currentRequests);

    } catch (err) {
        console.warn("Backend revalidation fallback to cache.");
    }
}

function renderOverviewStats(disasters, shelters, requests, alerts, commLogs) {
    const activeDisasters = disasters.filter(d => d.status !== "Resolved").length;
    const criticalCount = disasters.filter(d => d.severity === "Critical" && d.status !== "Resolved").length;
    const openShelters = shelters.filter(s => s.status === "Open").length;
    const pendingReqs = requests.filter(r => r.status === "Pending").length;
    const activeAlertsCount = alerts.length;
    const commCount = commLogs ? commLogs.length : 0;

    let totalCap = 0, totalOcc = 0;
    shelters.forEach(s => { totalCap += s.capacity; totalOcc += s.current_occupancy; });
    const utilizationRate = totalCap > 0 ? Math.round((totalOcc / totalCap) * 100) : 0;

    const elActiveDisasters = document.getElementById("stat-active-disasters");
    if (elActiveDisasters) elActiveDisasters.textContent = activeDisasters;

    const elCriticalCount = document.getElementById("stat-critical-count");
    if (elCriticalCount) elCriticalCount.textContent = criticalCount;

    const elOpenShelters = document.getElementById("stat-open-shelters");
    if (elOpenShelters) elOpenShelters.textContent = openShelters;

    const elShelterBed = document.getElementById("stat-shelter-bed-utilization");
    if (elShelterBed) elShelterBed.textContent = `${utilizationRate}%`;

    const elPendingReqs = document.getElementById("stat-pending-requests");
    if (elPendingReqs) elPendingReqs.textContent = pendingReqs;

    const elActiveAlerts = document.getElementById("stat-active-alerts");
    if (elActiveAlerts) elActiveAlerts.textContent = activeAlertsCount;

    const telecomStat = document.getElementById("stat-telecom-logs");
    if (telecomStat) telecomStat.textContent = commCount;

    // Ensure warning cards are not displayed directly on the Emergency Hub workspace (routed to top notification bell exclusively)
    const alertsBanner = document.getElementById("overview-alerts-banner");
    if (alertsBanner) {
        alertsBanner.innerHTML = "";
        alertsBanner.classList.add("hidden");
    }
    // Refresh top navbar notification counter with active warning alerts
    fetchUnreadNotificationCount();

    const recentDisastersList = document.getElementById("overview-recent-disasters");
    if (disasters.length === 0) {
        recentDisastersList.innerHTML = `<div class="p-8 text-center text-slate-400 text-xs">No active disaster incidents recorded.</div>`;
    } else {
        recentDisastersList.innerHTML = disasters.slice(0, 5).map(d => `
            <div class="flex items-center justify-between p-3.5 bg-slate-50 hover:bg-slate-100/80 rounded-2xl transition border border-slate-200/80">
                <div class="min-w-0 pr-2">
                    <div class="flex items-center gap-2 flex-wrap">
                        <span class="font-extrabold text-slate-900 text-xs">${d.type}</span>
                        <span class="text-[10px] px-2 py-0.5 rounded-full font-extrabold uppercase ${getSeverityBadge(d.severity)}">${d.severity}</span>
                    </div>
                    <p class="text-[11px] text-slate-500 mt-1 truncate">📍 ${d.location} &bull; ${new Date(d.created_at).toLocaleDateString()}</p>
                </div>
                <span class="text-[10px] px-2.5 py-1 rounded-xl font-extrabold shrink-0 ${getStatusBadge(d.status)}">${d.status}</span>
            </div>
        `).join("");
    }
}

function renderOverviewPanels(disasters, shelters, requests) {
    const shelterBars = document.getElementById("overview-shelter-bars");
    if (shelterBars) {
        if (shelters.length === 0) {
            shelterBars.innerHTML = `<div class="p-6 text-center text-slate-400 text-xs">No relief camps registered.</div>`;
        } else {
            shelterBars.innerHTML = shelters.slice(0, 4).map(s => {
                const pct = Math.min(100, Math.round((s.current_occupancy / s.capacity) * 100));
                return `
                    <div class="p-3 bg-slate-50 rounded-xl border border-slate-100">
                        <div class="flex items-center justify-between text-xs mb-1">
                            <span class="font-extrabold text-slate-900 truncate">${s.name}</span>
                            <span class="font-mono text-slate-600 shrink-0">${s.current_occupancy}/${s.capacity} beds (${pct}%)</span>
                        </div>
                        <div class="w-full h-2 bg-slate-200 rounded-full overflow-hidden">
                            <div class="h-full rounded-full ${pct >= 90 ? 'bg-red-600' : pct >= 60 ? 'bg-amber-500' : 'bg-emerald-500'}" style="width: ${pct}%"></div>
                        </div>
                    </div>
                `;
            }).join("");
        }
    }

    const reqList = document.getElementById("overview-requests-list");
    if (reqList) {
        if (requests.length === 0) {
            reqList.innerHTML = `<div class="p-6 text-center text-slate-400 text-xs">No supply requests pending.</div>`;
        } else {
            reqList.innerHTML = requests.slice(0, 4).map(r => `
                <div class="flex items-center justify-between p-3 bg-slate-50 rounded-xl border border-slate-100">
                    <div class="min-w-0 pr-2">
                        <div class="font-extrabold text-slate-900 text-xs truncate">${r.item_name} (Qty: ${r.quantity_requested})</div>
                        <p class="text-[11px] text-slate-500 truncate">Destination: ${r.delivery_location}</p>
                    </div>
                    <span class="text-[10px] px-2 py-0.5 rounded font-extrabold shrink-0 ${getStatusBadge(r.status)}">${r.status}</span>
                </div>
            `).join("");
        }
    }
}

// ==================== DISASTER VISUAL SIGNS HELPER ====================
function getDisasterVisualSign(type, severity) {
    const t = (type || "").toLowerCase();
    const s = (severity || "").toLowerCase();
    
    let icon = "⚠️";
    let bg = "#dc2626";
    let border = "#fca5a5";
    let glow = "rgba(220, 38, 38, 0.4)";

    if (t.includes("flood") && !t.includes("cloudburst")) {
        icon = "🌊";
        bg = "#2563eb";
        border = "#93c5fd";
        glow = "rgba(37, 99, 235, 0.4)";
    } else if (t.includes("cyclone") || t.includes("storm")) {
        icon = "🌪️";
        bg = "#7c3aed";
        border = "#c4b5fd";
        glow = "rgba(124, 58, 237, 0.4)";
    } else if (t.includes("landslide") || t.includes("mudflow")) {
        icon = "⛰️";
        bg = "#b45309";
        border = "#fcd34d";
        glow = "rgba(180, 83, 9, 0.4)";
    } else if (t.includes("fire")) {
        icon = "🔥";
        bg = "#e11d48";
        border = "#fda4af";
        glow = "rgba(225, 29, 72, 0.4)";
    } else if (t.includes("earthquake") || t.includes("collapse")) {
        icon = "🏚️";
        bg = "#581c87";
        border = "#d8b4fe";
        glow = "rgba(88, 28, 135, 0.4)";
    } else if (t.includes("cloudburst") || t.includes("urban flood")) {
        icon = "🌧️";
        bg = "#0891b2";
        border = "#67e8f9";
        glow = "rgba(8, 145, 178, 0.4)";
    } else if (t.includes("heatwave")) {
        icon = "☀️";
        bg = "#ea580c";
        border = "#fdba74";
        glow = "rgba(234, 88, 12, 0.4)";
    }

    return { icon, bg, border, glow, isCritical: s === "critical" };
}

function createDisasterDivIcon(type, severity, size = 32) {
    const sign = getDisasterVisualSign(type, severity);
    const pulseHtml = sign.isCritical ? `<div style="
        position: absolute;
        inset: -6px;
        border-radius: 50%;
        background: ${sign.glow};
        animation: ping 1.5s cubic-bezier(0, 0, 0.2, 1) infinite;
        z-index: 1;
    "></div>` : "";

    return L.divIcon({
        className: "custom-disaster-marker",
        iconSize: [size, size],
        iconAnchor: [size / 2, size / 2],
        html: `
            <div style="position: relative; width: ${size}px; height: ${size}px;">
                ${pulseHtml}
                <div style="
                    position: relative;
                    z-index: 2;
                    width: ${size}px;
                    height: ${size}px;
                    background: ${sign.bg};
                    border: 2px solid ${sign.border};
                    border-radius: 50%;
                    display: flex;
                    align-items: center;
                    justify-content: center;
                    font-size: ${size * 0.52}px;
                    box-shadow: 0 4px 10px rgba(0,0,0,0.35);
                    cursor: pointer;
                    transition: transform 0.2s;
                ">
                    ${sign.icon}
                </div>
            </div>
        `
    });
}

function createShelterDivIcon(isFull, size = 28) {
    const bg = isFull ? "#475569" : "#059669";
    const border = isFull ? "#94a3b8" : "#6ee7b7";
    return L.divIcon({
        className: "custom-shelter-marker",
        iconSize: [size, size],
        iconAnchor: [size / 2, size / 2],
        html: `
            <div style="
                width: ${size}px;
                height: ${size}px;
                background: ${bg};
                border: 2px solid ${border};
                border-radius: 50%;
                display: flex;
                align-items: center;
                justify-content: center;
                font-size: ${size * 0.52}px;
                box-shadow: 0 3px 8px rgba(0,0,0,0.3);
                cursor: pointer;
            ">
                🏕️
            </div>
        `
    });
}

function createMissingPersonDivIcon(size = 26) {
    return L.divIcon({
        className: "custom-missing-marker",
        iconSize: [size, size],
        iconAnchor: [size / 2, size / 2],
        html: `
            <div style="
                width: ${size}px;
                height: ${size}px;
                background: #7c3aed;
                border: 2px solid #ddd6fe;
                border-radius: 50%;
                display: flex;
                align-items: center;
                justify-content: center;
                font-size: ${size * 0.52}px;
                box-shadow: 0 3px 8px rgba(0,0,0,0.3);
                cursor: pointer;
            ">
                👥
            </div>
        `
    });
}

const INDIA_BOUNDS = [
    [6.8, 68.0],   // Southernmost/Westernmost tip
    [36.0, 97.5]   // Northernmost/Easternmost tip
];

function focusIndiaMap(targetMap) {
    if (!targetMap) return;
    targetMap.fitBounds(INDIA_BOUNDS, { padding: [12, 12], animate: true });
}

// ==================== OVERVIEW MINI MAP ====================
function initOverviewMap() {
    const el = document.getElementById("overview-map");
    if (!el) return;

    if (overviewMap) {
        // Multiple delays ensure tile fill completes even with CSS transitions
        [100, 300, 600].forEach(d => setTimeout(() => {
            if (overviewMap) {
                overviewMap.invalidateSize();
                focusIndiaMap(overviewMap);
            }
        }, d));
        return;
    }

    // India focused viewport: fit exact India bounding box
    overviewMap = L.map("overview-map", { zoomControl: false });
    overviewMap.fitBounds(INDIA_BOUNDS, { padding: [10, 10] });

    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: '&copy; OpenStreetMap contributors',
        maxZoom: 18
    }).addTo(overviewMap);

    overviewDisastersLayer = L.layerGroup().addTo(overviewMap);
    overviewSheltersLayer = L.layerGroup().addTo(overviewMap);
    overviewMissingPersonsLayer = L.layerGroup().addTo(overviewMap);

    loadOverviewMapData();

    // Staggered invalidate for reliable tile coverage on first load
    [100, 300, 600, 1200].forEach(d => setTimeout(() => overviewMap.invalidateSize(), d));

    // Auto-fit whenever the container resizes (e.g. sidebar open/close, window resize)
    if (typeof ResizeObserver !== "undefined") {
        new ResizeObserver(() => {
            if (overviewMap) overviewMap.invalidateSize();
        }).observe(el);
    }
}

async function loadOverviewMapData() {
    if (!overviewMap) return;
    try {
        const [disastersRes, sheltersRes, missingRes] = await Promise.all([
            fetch(`${API_BASE}/disasters/`),
            fetch(`${API_BASE}/shelters/`),
            fetch(`${API_BASE}/missing-persons/?status=MISSING&limit=100`)
        ]);
        const disasters = await disastersRes.json();
        const shelters = await sheltersRes.json();
        const missingPersons = missingRes.ok ? await missingRes.json() : [];

        overviewDisastersLayer.clearLayers();
        overviewSheltersLayer.clearLayers();
        overviewMissingPersonsLayer.clearLayers();

        disasters.forEach(d => {
            if (!d.latitude || !d.longitude) return;
            const sign = getDisasterVisualSign(d.type, d.severity);
            const icon = createDisasterDivIcon(d.type, d.severity, 28);
            L.marker([d.latitude, d.longitude], { icon })
                .bindPopup(`
                    <div style="font-family: sans-serif; min-width: 180px; padding: 4px;">
                        <div style="font-weight: 800; font-size: 13px; margin-bottom: 2px;">${sign.icon} ${d.type}</div>
                        <div style="font-size: 11px; color: #475569; margin-bottom: 4px;">📍 ${d.location}</div>
                        <div style="display: inline-block; font-size: 10px; font-weight: 800; padding: 2px 6px; border-radius: 6px; background: #fee2e2; color: #991b1b; text-transform: uppercase;">${d.severity} Priority</div>
                    </div>
                `)
                .addTo(overviewDisastersLayer);
        });

        shelters.forEach(s => {
            if (!s.latitude || !s.longitude) return;
            const isFull = s.status === "Full" || s.current_occupancy >= s.capacity;
            const icon = createShelterDivIcon(isFull, 24);
            L.marker([s.latitude, s.longitude], { icon })
                .bindPopup(`
                    <div style="font-family: sans-serif; min-width: 180px; padding: 4px;">
                        <div style="font-weight: 800; font-size: 13px; color: #047857;">🏕️ ${s.name}</div>
                        <div style="font-size: 11px; color: #475569;">📍 ${s.location}</div>
                        <div style="font-size: 11px; font-weight: 700; color: #1e293b; margin-top: 4px;">Beds: ${s.capacity - s.current_occupancy} available</div>
                    </div>
                `)
                .addTo(overviewSheltersLayer);
        });

        missingPersons.forEach(mp => {
            if (!mp.last_seen_latitude || !mp.last_seen_longitude) return;
            const icon = createMissingPersonDivIcon(22);
            L.marker([mp.last_seen_latitude, mp.last_seen_longitude], { icon })
                .bindPopup(`<strong>👥 ${mp.full_name}</strong><br>📍 ${mp.last_seen_location}<br><small>Last seen: ${new Date(mp.last_seen_date).toLocaleDateString("en-IN")}</small>`)
                .addTo(overviewMissingPersonsLayer);
        });
    } catch (e) {}
}

// ==================== GIS & DYNAMIC HEATMAP MODULE ====================

// Deterministic severity → heat intensity mapping
const SEVERITY_INTENSITY = {
    "critical": 1.00,
    "high":     0.75,
    "medium":   0.50,
    "low":      0.25
};

function severityToIntensity(severity) {
    const key = (severity || "").toLowerCase().trim();
    return SEVERITY_INTENSITY[key] ?? 0.30; // safe default for unknown values
}

// Compute radius/blur dynamically from zoom level so heatmap looks good at all scales
function getHeatOptionsForZoom(zoom) {
    // At India-wide view (zoom 4-5): large radius needed
    // At district view (zoom 10+): small, precise radius
    const radius = Math.max(15, Math.min(60, 10 + (zoom * 4)));
    const blur   = Math.max(10, Math.min(40, 8 + (zoom * 3)));
    return {
        radius,
        blur,
        maxZoom: 18,
        max: 1.0,
        gradient: {
            0.15: '#1d4ed8',   // blue — low intensity
            0.35: '#06b6d4',   // cyan
            0.55: '#eab308',   // yellow
            0.75: '#f97316',   // orange
            1.00: '#dc2626'    // red — critical
        }
    };
}

// Show/hide the "no heatmap data" overlay
function setHeatmapNoDataState(show, message) {
    let banner = document.getElementById("heatmap-nodata-banner");
    if (!banner) {
        // Create the banner if it doesn't exist
        banner = document.createElement("div");
        banner.id = "heatmap-nodata-banner";
        banner.className = "absolute inset-0 z-10 flex flex-col items-center justify-center bg-slate-900/60 backdrop-blur-sm rounded-2xl pointer-events-none";
        const mapCard = document.querySelector("#tab-map .command-card");
        if (mapCard) mapCard.appendChild(banner);
    }
    if (show) {
        banner.innerHTML = `
            <div class="text-center p-6 bg-slate-900/80 rounded-2xl border border-slate-700 max-w-sm">
                <div class="text-3xl mb-3">🗺️</div>
                <div class="text-white font-extrabold text-sm mb-1">No Heatmap Data Available</div>
                <div class="text-slate-300 text-xs">${message || "No active incidents with GPS coordinates found."}</div>
                <div class="text-slate-400 text-[11px] mt-2">Report incidents with latitude/longitude to generate heatmap.</div>
            </div>`;
        banner.classList.remove("hidden");
    } else {
        banner.classList.add("hidden");
    }
}

function initMap() {
    const el = document.getElementById("map");
    if (!el) return;

    if (map) {
        // Multiple delays guarantee tile fill even with flex animation
        [100, 300, 600].forEach(d => setTimeout(() => {
            if (map) {
                map.invalidateSize();
                focusIndiaMap(map);
            }
        }, d));
        return;
    }

    // India default viewport — fit exact India bounds
    map = L.map("map", { zoomControl: true });
    map.fitBounds(INDIA_BOUNDS, { padding: [10, 10] });
    L.tileLayer("https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png", {
        attribution: '&copy; OpenStreetMap contributors',
        maxZoom: 18
    }).addTo(map);

    disastersLayer = L.layerGroup().addTo(map);
    sheltersLayer = L.layerGroup().addTo(map);
    missingPersonsLayer = L.layerGroup().addTo(map);

    // Update heatmap options when user zooms
    map.on("zoomend", () => {
        if (heatLayer && map.hasLayer(heatLayer)) {
            heatLayer.setOptions(getHeatOptionsForZoom(map.getZoom()));
        }
    });

    // Staggered invalidate for reliable full tile coverage on first load
    [50, 200, 500, 1000].forEach(d => setTimeout(() => {
        if (map) {
            map.invalidateSize();
            focusIndiaMap(map);
        }
    }, d));

    // Auto-fit whenever the container resizes (sidebar open/close, window resize)
    if (typeof ResizeObserver !== "undefined") {
        new ResizeObserver(() => {
            if (map) map.invalidateSize();
        }).observe(el);
    }
}

function panMapTo(lat, lng, zoom = 8) {
    if (!map) initMap();
    map.setView([lat, lng], zoom, { animate: true });
}

function setMapVisualMode(mode) {
    mapVisualMode = mode;
    ["both", "heat", "markers"].forEach(m => {
        const btn = document.getElementById(`map-mode-${m}`);
        if (btn) {
            btn.className = (m === mode)
                ? "px-2.5 py-1 rounded-md bg-white text-slate-900 shadow-sm font-bold transition"
                : "px-2.5 py-1 rounded-md text-slate-600 hover:text-slate-900 transition";
        }
    });

    const chkHeat = document.getElementById("layer-heatmap");
    const chkDis  = document.getElementById("layer-disasters");
    const chkSh   = document.getElementById("layer-shelters");

    if (mode === "heat") {
        if (chkHeat) chkHeat.checked = true;
        if (chkDis)  chkDis.checked  = false;
        if (chkSh)   chkSh.checked   = false;
    } else if (mode === "markers") {
        if (chkHeat) chkHeat.checked = false;
        if (chkDis)  chkDis.checked  = true;
        if (chkSh)   chkSh.checked   = true;
    } else {
        if (chkHeat) chkHeat.checked = true;
        if (chkDis)  chkDis.checked  = true;
        if (chkSh)   chkSh.checked   = true;
    }
    toggleGISLayers();
}

// Rebuild the heatmap layer from currentHeatmapPoints (non-destructive to markers)
function rebuildHeatLayer() {
    if (heatLayer) {
        map.removeLayer(heatLayer);
        heatLayer = null;
    }

    // Filter to only points with valid numeric coords
    const validPoints = (currentHeatmapPoints || []).filter(
        p => p.latitude != null && p.longitude != null &&
             !isNaN(Number(p.latitude)) && !isNaN(Number(p.longitude))
    );

    // Check if L.heatLayer plugin is available
    if (typeof L.heatLayer !== "function") {
        console.error("[Heatmap] L.heatLayer is not available — check leaflet-heat.js script tag");
        setHeatmapNoDataState(true, "Heatmap plugin failed to load. Please check network connectivity.");
        return;
    }

    if (validPoints.length === 0) {
        setHeatmapNoDataState(true, "No active incidents with GPS coordinates found.");
        return;
    }

    setHeatmapNoDataState(false);

    const heatArray = validPoints.map(p => [
        Number(p.latitude),
        Number(p.longitude),
        severityToIntensity(p.severity)
    ]);

    console.log(`[Heatmap] Building layer with ${heatArray.length} points:`, heatArray.slice(0, 3));

    const zoom = map ? map.getZoom() : 5;
    heatLayer = L.heatLayer(heatArray, getHeatOptionsForZoom(zoom));

    if (document.getElementById("layer-heatmap")?.checked !== false) {
        heatLayer.addTo(map);
        console.log("[Heatmap] Layer added to map successfully");
    }
}

function applyHeatmapFilters() {
    loadMapData();
}

function resetHeatmapFilters() {
    const hazardEl = document.getElementById("heatmap-filter-hazard");
    const sevEl = document.getElementById("heatmap-filter-severity");
    const stateEl = document.getElementById("heatmap-filter-state");
    const daysEl = document.getElementById("heatmap-filter-days");

    if (hazardEl) hazardEl.value = "";
    if (sevEl) sevEl.value = "";
    if (stateEl) stateEl.value = "";
    if (daysEl) daysEl.value = "";

    loadMapData();
}

async function loadMapData() {
    if (!map) initMap();

    const hazardVal = document.getElementById("heatmap-filter-hazard")?.value || "";
    const sevVal    = document.getElementById("heatmap-filter-severity")?.value || "";
    const stateVal  = document.getElementById("heatmap-filter-state")?.value || "";
    const daysVal   = document.getElementById("heatmap-filter-days")?.value || "";

    const heatParams = new URLSearchParams({ active_only: "true" });
    const disasterParams = new URLSearchParams({});

    if (hazardVal) {
        heatParams.append("hazard_type", hazardVal);
        disasterParams.append("type", hazardVal);
    }
    if (sevVal) {
        heatParams.append("severity", sevVal);
        disasterParams.append("severity", sevVal);
    }
    if (stateVal) {
        heatParams.append("state", stateVal);
    }
    if (daysVal) {
        heatParams.append("days", daysVal);
    }

    try {
        let disasters = [];
        let shelters = [];
        let heatmapPoints = [];
        let missingPersons = [];

        try {
            const [disastersRes, sheltersRes, heatRes, missingRes] = await Promise.all([
                fetch(`${API_BASE}/disasters/?${disasterParams.toString()}`).catch(() => null),
                fetch(`${API_BASE}/shelters/`).catch(() => null),
                fetch(`${API_BASE}/disasters/heatmap?${heatParams.toString()}`).catch(() => null),
                fetch(`${API_BASE}/missing-persons/?status=MISSING&limit=100`).catch(() => null)
            ]);

            if (disastersRes && disastersRes.ok) disasters = await disastersRes.json();
            else disasters = OfflineManager.getCache("disasters") || [];

            if (sheltersRes && sheltersRes.ok) shelters = await sheltersRes.json();
            else shelters = OfflineManager.getCache("shelters") || [];

            if (heatRes && heatRes.ok) heatmapPoints = await heatRes.json();
            else heatmapPoints = disasters.map(d => ({ latitude: d.latitude, longitude: d.longitude, weight: d.severity === "Critical" ? 1.0 : 0.6 }));

            if (missingRes && missingRes.ok) missingPersons = await missingRes.json();

        } catch (netErr) {
            console.warn("[Map] Network fetch issue, loading cached map layers:", netErr);
            disasters = OfflineManager.getCache("disasters") || [];
            shelters = OfflineManager.getCache("shelters") || [];
            heatmapPoints = disasters.map(d => ({ latitude: d.latitude, longitude: d.longitude, weight: 0.7 }));
        }

        currentDisasters = disasters;
        currentShelters = shelters;
        currentHeatmapPoints = heatmapPoints;

        // Update active filter counter in UI
        const countEl = document.getElementById("heatmap-filter-count");
        if (countEl) {
            countEl.textContent = `Showing ${currentHeatmapPoints.length} hotspot(s) • ${currentDisasters.length} incident(s)`;
        }

        console.log(`[Map] Loaded ${currentDisasters.length} disasters, ${currentShelters.length} shelters, ${currentHeatmapPoints.length} heatmap points, ${missingPersons.length} missing persons`);

        disastersLayer.clearLayers();
        sheltersLayer.clearLayers();
        if (missingPersonsLayer) missingPersonsLayer.clearLayers();

        // ── 1. Heatmap Layer ──────────────────────────────────────────
        rebuildHeatLayer();

        const bounds = [];

        // ── 2. Disaster Markers with Distinct Visual Signs ──────────────────────────────
        currentDisasters.forEach(d => {
            if (!d.latitude || !d.longitude) return;
            const sign = getDisasterVisualSign(d.type, d.severity);
            const icon = createDisasterDivIcon(d.type, d.severity, 34);

            const marker = L.marker([d.latitude, d.longitude], {
                icon: icon,
                pane: "markerPane"
            });

            marker.bindPopup(`
                <div class="p-3 space-y-2 min-w-[240px] font-sans">
                    <div class="flex items-center justify-between gap-2 border-b border-slate-100 pb-2">
                        <div class="flex items-center gap-1.5 font-black text-slate-900 text-sm">
                            <span class="text-lg">${sign.icon}</span>
                            <span>${d.type}</span>
                        </div>
                        <span class="text-[10px] px-2 py-0.5 rounded-full font-black text-white uppercase" style="background:${sign.bg};">${d.severity}</span>
                    </div>
                    <p class="text-xs text-slate-700 font-bold">📍 ${d.location}</p>
                    <p class="text-xs text-slate-600 leading-snug">${d.description || "Active emergency incident logged."}</p>
                    <div class="pt-2 border-t border-slate-100 flex items-center justify-between text-[11px]">
                        <span class="font-semibold text-slate-500">Status: <strong class="text-blue-600">${d.status}</strong></span>
                        <span class="font-mono text-slate-400">GPS: ${Number(d.latitude).toFixed(3)}, ${Number(d.longitude).toFixed(3)}</span>
                    </div>
                </div>
            `);

            marker.addTo(disastersLayer);
            bounds.push([d.latitude, d.longitude]);
        });

        // ── 3. Shelter Markers ────────────────────────────────────────
        currentShelters.forEach(s => {
            if (!s.latitude || !s.longitude) return;
            const isFull = s.status === "Full" || s.current_occupancy >= s.capacity;
            const icon = createShelterDivIcon(isFull, 30);

            const marker = L.marker([s.latitude, s.longitude], {
                icon: icon,
                pane: "markerPane"
            });

            const percent = Math.round((s.current_occupancy / s.capacity) * 100);
            marker.bindPopup(`
                <div class="p-3 space-y-2 min-w-[240px] font-sans">
                    <div class="flex items-center justify-between gap-2 border-b border-slate-100 pb-2">
                        <span class="font-black text-emerald-800 text-sm">🏕️ ${s.name}</span>
                        <span class="text-[10px] px-2 py-0.5 rounded-full font-bold ${isFull ? "bg-red-100 text-red-800" : "bg-emerald-100 text-emerald-800"}">${s.status}</span>
                    </div>
                    <p class="text-xs text-slate-600">📍 ${s.location}</p>
                    <div class="text-xs font-bold text-slate-800 flex items-center justify-between">
                        <span>Capacity: ${s.current_occupancy} / ${s.capacity} beds</span>
                        <span class="text-emerald-700">${percent}% full</span>
                    </div>
                    <p class="text-xs text-slate-500">📞 ${s.contact_phone || s.contact_person || "Contact Control Room"}</p>
                </div>
            `);

            marker.addTo(sheltersLayer);
            bounds.push([s.latitude, s.longitude]);
        });

        // ── 4. Missing Persons Pin Layer ──────────────────────────────
        if (missingPersonsLayer) {
            missingPersons.forEach(mp => {
                if (!mp.last_seen_latitude || !mp.last_seen_longitude) return;
                const icon = createMissingPersonDivIcon(26);

                const mpMarker = L.marker(
                    [mp.last_seen_latitude, mp.last_seen_longitude],
                    { icon: icon, pane: "markerPane" }
                );

                mpMarker.bindPopup(`
                    <div class="p-3 space-y-1.5 min-w-[220px] font-sans">
                        <div class="flex items-center justify-between border-b border-slate-100 pb-1.5">
                            <span class="font-black text-purple-900 text-sm">👥 ${mp.full_name}</span>
                            <span class="text-[10px] px-2 py-0.5 rounded bg-purple-100 text-purple-800 font-bold uppercase">${mp.status}</span>
                        </div>
                        <p class="text-xs text-slate-700">📍 Last seen: ${mp.last_seen_location}</p>
                        <p class="text-xs text-slate-500">Age: ${mp.age || '--'} • Gender: ${mp.gender || '--'}</p>
                        <p class="text-xs text-slate-500">${mp.description || "No clothing description."}</p>
                        <div class="pt-1.5 border-t border-slate-100 text-[11px] text-purple-700 font-bold">
                            📞 Contact: ${mp.contact_phone || "NDRF HQ"}
                        </div>
                    </div>
                `);

                mpMarker.addTo(missingPersonsLayer);
            });
        }

        // ── 5. Persistent India Default Viewport ─────────────────────
        // Only auto-fit bounds on the very first load AND only when there are
        // enough points well outside India center (meaningful data).
        // Never override the India default with an empty or single-point fitBounds.
        if (bounds.length >= 2 && !map._hasFitted) {
            map.fitBounds(bounds, { padding: [50, 50], maxZoom: 10 });
            map._hasFitted = true;
        }

    } catch (err) {
        console.error("[Map] Failed to load map data:", err);
        showToast("Could not load map data. Check server connection.", "error");
    }
}

function toggleGISLayers() {
    const showHeat          = document.getElementById("layer-heatmap")?.checked;
    const showDisasters     = document.getElementById("layer-disasters")?.checked;
    const showShelters      = document.getElementById("layer-shelters")?.checked;
    const showMissingPers   = document.getElementById("layer-missing-persons")?.checked;

    if (heatLayer) {
        if (showHeat) map.addLayer(heatLayer);
        else map.removeLayer(heatLayer);
    }
    if (disastersLayer) {
        if (showDisasters) map.addLayer(disastersLayer);
        else map.removeLayer(disastersLayer);
    }
    if (sheltersLayer) {
        if (showShelters) map.addLayer(sheltersLayer);
        else map.removeLayer(sheltersLayer);
    }
    if (missingPersonsLayer) {
        if (showMissingPers) map.addLayer(missingPersonsLayer);
        else map.removeLayer(missingPersonsLayer);
    }
}




// ==================== DISASTERS MODULE ====================
async function loadDisasters() {
    const statusFilter = document.getElementById("filter-disaster-status")?.value || "";
    const severityFilter = document.getElementById("filter-disaster-severity")?.value || "";

    let url = `${API_BASE}/disasters/?`;
    if (statusFilter) url += `status=${encodeURIComponent(statusFilter)}&`;
    if (severityFilter) url += `severity=${encodeURIComponent(severityFilter)}&`;

    try {
        const res = await fetch(url);
        currentDisasters = await res.json();
        OfflineManager.setCache("disasters", currentDisasters);
        renderDisastersTable(currentDisasters);
    } catch (err) {
        const cached = OfflineManager.getCache("disasters") || [];
        renderDisastersTable(cached);
    }
}

function resetDisasterFilters() {
    document.getElementById("filter-disaster-status").value = "";
    document.getElementById("filter-disaster-severity").value = "";
    loadDisasters();
}

function renderDisastersTable(disasters) {
    const tbody = document.getElementById("disasters-table-body");
    if (disasters.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" class="p-8 text-center text-slate-400">No matching disaster reports found.</td></tr>`;
        return;
    }

    tbody.innerHTML = disasters.map(d => {
        const mergedReports = d.merged_reports || [];
        const hasMerged = mergedReports.length > 0 || (d.corroborating_reports_count && d.corroborating_reports_count > 1);
        const reportCount = Math.max(d.corroborating_reports_count || 1, mergedReports.length);

        return `
            <tr class="hover:bg-slate-50/80 transition border-b border-slate-100">
                <td class="px-6 py-4 font-mono font-bold text-slate-500">
                    #${d.id}
                </td>
                <td class="px-6 py-4">
                    <div class="font-extrabold text-slate-950">${d.type}</div>
                    ${hasMerged ? `
                        <button onclick="toggleMergedReportsDrawer(${d.id})" class="mt-1 inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-[10px] font-mono font-black bg-purple-100 text-purple-800 hover:bg-purple-200 transition">
                            ⚡ ${reportCount} Reports Merged ▼
                        </button>
                    ` : ''}
                </td>
                <td class="px-6 py-4 text-slate-700 font-medium">${d.location}</td>
                <td class="px-6 py-4 font-mono text-[11px] text-slate-500">
                    ${d.latitude && d.longitude ? `${d.latitude.toFixed(3)}, ${d.longitude.toFixed(3)}` : "—"}
                </td>
                <td class="px-6 py-4">
                    <span class="text-[10px] px-2.5 py-1 rounded-full font-extrabold uppercase ${getSeverityBadge(d.severity)}">${d.severity}</span>
                </td>
                <td class="px-6 py-4">
                    <span class="text-[10px] px-2.5 py-1 rounded-xl font-extrabold ${getStatusBadge(d.status)}">${d.status}</span>
                </td>
                <td class="px-6 py-4 text-right">
                    <select onchange="updateDisasterStatus(${d.id}, this.value)" class="text-xs border border-slate-200 rounded-xl px-2.5 py-1 bg-white font-medium text-slate-700 focus:ring-2 focus:ring-blue-500 focus:outline-none">
                        <option value="">Update...</option>
                        <option value="Reported" ${d.status === "Reported" ? "disabled" : ""}>Reported</option>
                        <option value="Verified" ${d.status === "Verified" ? "disabled" : ""}>Verified</option>
                        <option value="In Progress" ${d.status === "In Progress" ? "disabled" : ""}>In Progress</option>
                        <option value="Resolved" ${d.status === "Resolved" ? "disabled" : ""}>Resolved</option>
                    </select>
                </td>
            </tr>
            ${hasMerged ? `
                <tr id="merged-reports-drawer-${d.id}" class="hidden bg-purple-50/40 border-b border-purple-100">
                    <td colspan="7" class="px-8 py-4">
                        <div class="p-4 bg-white rounded-2xl border border-purple-200 shadow-sm space-y-3">
                            <div class="flex items-center justify-between">
                                <span class="text-xs font-black uppercase text-purple-900 font-mono flex items-center gap-1.5">
                                    <span>⚡</span> Linked & Merged Citizen Incident Reports (Disaster #${d.id})
                                </span>
                                <span class="text-[11px] text-purple-700 font-bold">${reportCount} Merged Reports Consolidated</span>
                            </div>
                            ${mergedReports.length > 0 ? `
                                <div class="space-y-2">
                                    ${mergedReports.map(mr => `
                                        <div class="p-3 bg-purple-50/60 rounded-xl border border-purple-100 text-xs flex flex-col sm:flex-row sm:items-center justify-between gap-2">
                                            <div class="space-y-0.5">
                                                <div class="flex items-center gap-2">
                                                    <span class="font-extrabold text-slate-900">Report #${mr.id}: ${mr.type}</span>
                                                    <span class="px-1.5 py-0.5 bg-purple-200 text-purple-900 rounded text-[9px] font-mono font-bold">MERGED</span>
                                                </div>
                                                <p class="text-slate-600 text-[11px]">📍 ${mr.location}</p>
                                                ${mr.description ? `<p class="text-slate-500 text-[11px] italic">"${mr.description}"</p>` : ''}
                                            </div>
                                            <div class="text-right text-[11px] shrink-0 space-y-0.5">
                                                ${mr.reporter_name ? `<div class="font-bold text-slate-800">👤 ${mr.reporter_name}</div>` : ''}
                                                ${mr.reporter_phone ? `<div class="font-mono text-emerald-700 font-bold">📞 ${mr.reporter_phone}</div>` : ''}
                                                <div class="text-slate-400 text-[10px]">${new Date(mr.created_at).toLocaleString("en-IN", {timeZone:"Asia/Kolkata"})}</div>
                                            </div>
                                        </div>
                                    `).join("")}
                                </div>
                            ` : `
                                <div class="text-xs text-purple-950 font-medium">
                                    This primary disaster incident has been corroborated and consolidated from <strong>${reportCount} citizen reports</strong>.
                                </div>
                            `}
                        </div>
                    </td>
                </tr>
            ` : ''}
        `;
    }).join("");
}

function toggleMergedReportsDrawer(disasterId) {
    const drawer = document.getElementById(`merged-reports-drawer-${disasterId}`);
    if (drawer) drawer.classList.toggle("hidden");
}

// ==================== MAP LOCATION PICKER ====================
let tempPickerMarker = null;
function enableMapPickerMode() {
    closeModal("modal-report-disaster");
    switchTab("map");
    showToast("Click anywhere on the map to select incident location coordinates", "info");

    if (!map) initMap();

    const onMapClick = (e) => {
        const lat = e.latlng.lat.toFixed(4);
        const lng = e.latlng.lng.toFixed(4);

        document.getElementById("disaster-lat").value = lat;
        document.getElementById("disaster-lng").value = lng;

        if (tempPickerMarker) map.removeLayer(tempPickerMarker);
        tempPickerMarker = L.marker([lat, lng], { title: "Selected Location" }).addTo(map);

        map.off("click", onMapClick);
        openModal("modal-report-disaster");
        showToast(`Map location picked: ${lat}, ${lng}`, "success");
    };

    map.once("click", onMapClick);
}

function verifyUserCanReport() {
    return true;
}

// ==================== SMART INCIDENT REPORT SUBMISSION ====================
async function reportDisaster(e) {
    if (e) {
        e.preventDefault();
        e.stopPropagation();
    }

    const nameEl = document.getElementById("report-reporter-name");
    const phoneEl = document.getElementById("report-reporter-phone");
    const locationEl = document.getElementById("disaster-location");
    const descEl = document.getElementById("disaster-description");
    const reliefEl = document.getElementById("report-relief-type");
    const hazardEl = document.getElementById("disaster-type");
    const latEl = document.getElementById("disaster-lat");
    const lngEl = document.getElementById("disaster-lng");
    const imageFileInput = document.getElementById("report-image-file");

    const reporterName = nameEl ? nameEl.value.trim() : "";
    const reporterPhone = phoneEl ? phoneEl.value.trim() : "";
    const location = locationEl ? locationEl.value.trim() : "";
    const description = descEl ? descEl.value.trim() : "";
    const reliefType = reliefEl ? reliefEl.value : "General Emergency Assistance";
    const hazardCategory = hazardEl ? hazardEl.value : "Flood";
    const lat = latEl ? latEl.value.trim() : "";
    const lng = lngEl ? lngEl.value.trim() : "";

    // Validation for compulsory fields
    if (!reporterName) {
        showToast("Please enter your Full Name (Compulsory).", "warning");
        if (nameEl) nameEl.focus();
        return false;
    }
    if (!reporterPhone || reporterPhone.length < 10) {
        showToast("Please enter a valid 10-digit Phone Number (Compulsory).", "warning");
        if (phoneEl) phoneEl.focus();
        return false;
    }
    if (!location) {
        showToast("Please enter or auto-detect Incident Location/Address (Compulsory).", "warning");
        if (locationEl) locationEl.focus();
        return false;
    }
    if (!description || description.length < 10) {
        showToast("Please provide a detailed Situation Description (Compulsory, min 10 characters).", "warning");
        if (descEl) descEl.focus();
        return false;
    }

    const formData = new FormData();
    formData.append("reporter_name", reporterName);
    formData.append("reporter_phone", reporterPhone);
    formData.append("location", location);
    formData.append("description", description);
    formData.append("relief_type_required", reliefType);
    formData.append("category", hazardCategory);
    formData.append("severity", "High");

    if (lat) formData.append("latitude", lat);
    if (lng) formData.append("longitude", lng);

    if (imageFileInput && imageFileInput.files && imageFileInput.files.length > 0) {
        formData.append("photo", imageFileInput.files[0]);
    }

    showToast("Transmitting emergency SOS report to Disaster Authorities & NDRF...", "info");

    try {
        const res = await fetch(`${API_BASE}/reports/`, {
            method: "POST",
            body: formData
        });

        if (res.ok) {
            const reportResult = await res.json();
            showToast(`🚨 Emergency Report #${reportResult.report_id || ''} DISPATCHED! Transmitted to State Emergency Command & NDRF Response Unit.`, "success");
            closeModal("modal-report-disaster");
            document.getElementById("form-report-disaster").reset();
            
            // Auto refresh overview, maps, and queues
            loadOverview();
            if (map) loadMapData();
            if (activeTab === "verification") loadVerificationQueue();
            if (activeTab === "disasters") loadDisasters();
            if (activeTab === "authority-dashboard") loadAuthorityDashboard();
        } else {
            const errData = await res.json().catch(() => ({}));
            showToast(`Failed to submit report: ${errData.detail || "Server error"}`, "error");
        }
    } catch (err) {
        console.error("Report submission error:", err);
        showToast("Network error submitting report to backend.", "error");
    }
}

// ==================== AI VERIFICATION & DUPLICATE QUEUE ====================
async function loadVerificationQueue() {
    const listEl = document.getElementById("verification-queue-list");
    if (!listEl) return;

    if (!currentUser || !["AUTHORITY_VERIFIED", "ADMIN"].includes(currentUser.role)) {
        listEl.innerHTML = `<div class="command-card p-12 text-center space-y-3"><div class="text-3xl">🔐</div><div class="font-extrabold text-slate-700 text-sm">Authority Access Required</div><p class="text-xs text-slate-400">Only Verified Authorities and Administrators can access the AI Duplicate Verification Queue.</p></div>`;
        return;
    }

    try {
        const res = await fetch(`${API_BASE}/verification/pending`, {
            headers: authHeaders()
        });
        const matches = await res.json();
        renderVerificationQueue(matches);
    } catch (err) {
        listEl.innerHTML = `<div class="command-card p-12 text-center text-slate-400 text-xs">Could not load verification queue. Check backend connection.</div>`;
    }
}

function renderVerificationQueue(matches) {
    const listEl = document.getElementById("verification-queue-list");
    if (!listEl) return;

    if (!matches || matches.length === 0) {
        listEl.innerHTML = `
            <div class="command-card p-12 text-center text-slate-400 text-xs space-y-2">
                <div class="text-3xl">✅</div>
                <div class="font-extrabold text-slate-700 text-sm">Verification Queue Clean</div>
                <p class="text-slate-400">All incoming reports have been verified or merged by AI and authorities.</p>
            </div>
        `;
        return;
    }

    listEl.innerHTML = matches.map(m => {
        const confPct = Math.round(m.confidence_score * 100);
        const signals = m.signals_breakdown || {};
        const report = m.report || {};
        const candidate = m.candidate_disaster || {};
        const hasDup = m.has_duplicate_candidate !== false && m.confidence_score >= 0.40;

        const badgeBg = hasDup ? (confPct >= 80 ? "bg-red-100 text-red-800 border-red-200" : "bg-purple-100 text-purple-800 border-purple-200")
                               : "bg-emerald-100 text-emerald-800 border-emerald-200";

        const badgeText = hasDup ? `🤖 ${confPct}% Duplicate Confidence (Nearby Match)`
                                 : `✨ Standalone Incident (100% Unique in Region)`;

        const distanceDisplay = signals.location_distance_meters != null
            ? (signals.location_distance_meters < 1000 ? `${signals.location_distance_meters}m` : `${(signals.location_distance_meters / 1000).toFixed(1)}km`)
            : "No Nearby Incident";

        return `
            <div id="verification-card-${m.id}" class="command-card p-6 space-y-5 border-l-4 ${hasDup ? (confPct >= 80 ? 'border-l-red-500' : 'border-l-purple-500') : 'border-l-emerald-500'}">
                <!-- Header: Confidence Badge & Explanation -->
                <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-3 border-b border-slate-100 pb-4">
                    <div class="flex items-center gap-3">
                        <span class="text-xs px-3 py-1 rounded-full font-mono font-extrabold border ${badgeBg}">
                            ${badgeText}
                        </span>
                        <span class="text-xs font-bold text-slate-500">Report #${m.report_id || m.id}</span>
                    </div>
                    <span class="text-xs text-slate-400">Received ${new Date(m.created_at).toLocaleTimeString("en-IN", {timeZone:"Asia/Kolkata"})}</span>
                </div>

                <!-- Explanation Banner -->
                <div class="p-3 ${hasDup ? 'bg-purple-50 border-purple-100 text-purple-950' : 'bg-emerald-50 border-emerald-100 text-emerald-950'} rounded-xl border text-xs font-medium flex items-center gap-2">
                    <span class="text-base">${hasDup ? '💡' : '📍'}</span>
                    <span><strong>AI Spatial Analysis:</strong> ${signals.explanation || "Incident verified by spatial engine."}</span>
                </div>

                <!-- Signal Metric Cards Grid -->
                <div class="grid grid-cols-2 sm:grid-cols-5 gap-2.5 text-center text-xs">
                    <div class="p-2.5 bg-slate-50 rounded-xl border border-slate-100">
                        <span class="text-[10px] font-bold text-slate-400 uppercase block">Proximity Distance</span>
                        <span class="font-extrabold ${hasDup ? 'text-slate-900' : 'text-emerald-700'} font-mono">${distanceDisplay}</span>
                    </div>
                    <div class="p-2.5 bg-slate-50 rounded-xl border border-slate-100">
                        <span class="text-[10px] font-bold text-slate-400 uppercase block">Time Gap</span>
                        <span class="font-extrabold text-slate-900 font-mono">${signals.time_difference_minutes != null ? signals.time_difference_minutes + 'm' : 'N/A'}</span>
                    </div>
                    <div class="p-2.5 bg-slate-50 rounded-xl border border-slate-100">
                        <span class="text-[10px] font-bold text-slate-400 uppercase block">Hazard Category</span>
                        <span class="font-extrabold text-slate-900 font-mono">${Math.round((signals.category_score || 1.0) * 100)}%</span>
                    </div>
                    <div class="p-2.5 bg-slate-50 rounded-xl border border-slate-100">
                        <span class="text-[10px] font-bold text-slate-400 uppercase block">Text Similarity</span>
                        <span class="font-extrabold text-slate-900 font-mono">${Math.round((signals.text_score || 0) * 100)}%</span>
                    </div>
                    <div class="p-2.5 bg-slate-50 rounded-xl border border-slate-100 col-span-2 sm:col-span-1">
                        <span class="text-[10px] font-bold text-slate-400 uppercase block">Assistance Needs</span>
                        <span class="font-extrabold text-slate-900 font-mono">${Math.round((signals.needs_score || 1.0) * 100)}%</span>
                    </div>
                </div>

                <!-- Comparison Grid: Incoming Report vs Candidate Incident -->
                <div class="grid grid-cols-1 md:grid-cols-2 gap-4 pt-2">
                    <!-- Incoming Report -->
                    <div class="p-4 bg-slate-50 rounded-2xl border border-slate-200 space-y-2.5">
                        <div class="flex items-center justify-between">
                            <span class="text-[11px] font-extrabold text-blue-700 uppercase tracking-wider">📥 Incoming Citizen Report #${report.id || m.report_id}</span>
                            <span class="text-[10px] px-2 py-0.5 rounded bg-blue-100 text-blue-800 font-bold">${report.source || "WEB"}</span>
                        </div>
                        <div class="font-extrabold text-slate-950 text-sm">${report.type || "Hazard"}</div>
                        <p class="text-xs text-slate-700 font-semibold">📍 ${report.location || "Location unlisted"}</p>
                        <p class="text-xs text-slate-500 leading-snug">${report.description || "No description provided."}</p>
                        
                        ${report.image_url ? `
                            <div class="pt-2">
                                <div class="text-[10px] font-bold text-slate-500 uppercase tracking-wider mb-1.5 flex items-center gap-1.5">
                                    <span>📸 Incident Photo Evidence</span>
                                </div>
                                <div class="relative group rounded-xl overflow-hidden border border-slate-200 bg-slate-900 max-h-48 flex items-center justify-center cursor-pointer shadow-sm" onclick="window.open('${report.image_url.startsWith('http') ? report.image_url : API_BASE + report.image_url}', '_blank')">
                                    <img src="${report.image_url.startsWith('http') ? report.image_url : API_BASE + report.image_url}" alt="Incident Photo" class="max-h-48 w-full object-cover group-hover:scale-105 transition duration-200" onerror="this.parentElement.style.display='none'">
                                    <div class="absolute inset-0 bg-black/40 opacity-0 group-hover:opacity-100 transition flex items-center justify-center text-white text-xs font-bold gap-1.5">
                                        <span>🔍</span> Click to View Full Photo
                                    </div>
                                </div>
                            </div>
                        ` : ''}

                        <div class="text-[11px] font-bold text-slate-700 pt-1">
                            <span>👥 Affected: ${report.people_affected_count || 1}</span> &bull; 
                            <span>🆘 Needs: ${(report.assistance_needed || []).join(", ") || "General"}</span>
                        </div>
                    </div>

                    <!-- Candidate Existing Incident or Standalone Status -->
                    <div class="p-4 ${hasDup ? 'bg-purple-50/50 border-purple-200' : 'bg-emerald-50/50 border-emerald-200'} rounded-2xl border space-y-2">
                        <div class="flex items-center justify-between">
                            <span class="text-[11px] font-extrabold ${hasDup ? 'text-purple-800' : 'text-emerald-800'} uppercase tracking-wider">
                                ${hasDup ? `🎯 Corroborating Incident #${candidate.id || m.candidate_disaster_id}` : '🛡️ Standalone Incident Status'}
                            </span>
                            <span class="text-[10px] px-2 py-0.5 rounded ${hasDup ? 'bg-purple-100 text-purple-800' : 'bg-emerald-100 text-emerald-800'} font-bold">
                                ${candidate.status || (hasDup ? 'Verified' : 'New Incident')}
                            </span>
                        </div>
                        <div class="font-extrabold text-slate-950 text-sm">${candidate.type || (hasDup ? "Disaster Incident" : "New Primary Event")}</div>
                        <p class="text-xs text-slate-700 font-semibold">📍 ${candidate.location || report.location || "Location unlisted"}</p>
                        <p class="text-xs text-slate-500 leading-snug">${candidate.description || (hasDup ? "Existing primary incident record." : "Zero nearby duplicates detected in this state/district.")}</p>
                        <div class="text-[11px] font-bold ${hasDup ? 'text-purple-900' : 'text-emerald-900'} pt-1">
                            ${hasDup 
                                ? `<span>📊 Corroborating Reports: ${candidate.corroborating_reports_count || 2}</span> &bull; <span>👥 Verified Estimate: ${candidate.verified_people_affected || 15}</span>`
                                : `<span>✨ Clean Signal: No false duplicate overlap</span>`
                            }
                        </div>
                    </div>
                </div>

                <!-- Authority Decision Actions -->
                <div class="flex flex-wrap items-center justify-between gap-3 pt-3 border-t border-slate-100">
                    <span class="text-xs text-slate-500 font-medium">Authority Review Action</span>
                    <div class="flex items-center gap-2">
                        <button type="button" onclick="processVerificationAction(event, ${m.id}, 'REJECT')"
                            class="px-3.5 py-2 bg-slate-100 hover:bg-red-50 text-slate-700 hover:text-red-700 rounded-xl font-bold text-xs transition border border-slate-200">
                            ✕ Reject / False Report
                        </button>
                        <button type="button" onclick="processVerificationAction(event, ${m.id}, 'KEEP_SEPARATE')"
                            class="px-4 py-2 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl font-bold text-xs shadow-md shadow-emerald-500/20 transition flex items-center gap-1.5">
                            ✅ ${hasDup ? 'Keep Separate (Promote)' : 'Verify & Promote to Live Map'}
                        </button>
                        ${hasDup ? `
                        <button type="button" onclick="processVerificationAction(event, ${m.id}, 'MERGE')"
                            class="px-4 py-2 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-700 hover:to-indigo-700 text-white font-extrabold text-xs rounded-xl shadow-md shadow-purple-500/20 transition flex items-center gap-1.5">
                            ⚡ Merge Into Incident #${m.candidate_disaster_id}
                        </button>
                        ` : ''}
                    </div>
                </div>
            </div>
        `;
    }).join("");
}

async function processVerificationAction(e, matchId, action) {
    if (e) {
        if (typeof e.preventDefault === "function") e.preventDefault();
        if (typeof e.stopPropagation === "function") e.stopPropagation();
    }

    if (!currentUser || !["AUTHORITY_VERIFIED", "ADMIN"].includes(currentUser.role)) {
        showToast("Forbidden: Verified Authority credentials required for this action.", "error");
        return;
    }

    const scrollPos = window.scrollY;

    try {
        showToast(`Processing decision (${action})...`, "info");
        const res = await fetch(`${API_BASE}/verification/${matchId}/action`, {
            method: "POST",
            headers: authHeaders(),
            body: JSON.stringify({
                action: action,
                authority_name: currentUser?.name || "Command Officer"
            })
        });

        if (res.ok) {
            const data = await res.json();
            showToast(data.message, "success");

            // Update card in-place statically so window position remains 100% frozen
            const card = document.getElementById(`verification-card-${matchId}`);
            if (card && data.disaster) {
                if (data.action === "MERGE") {
                    card.className = "command-card p-6 space-y-4 border-l-4 border-l-emerald-500 bg-gradient-to-r from-slate-900 to-purple-950 text-white rounded-3xl shadow-xl transition-all";
                    card.innerHTML = `
                        <div class="flex items-center justify-between">
                            <div class="flex items-center gap-2">
                                <span class="px-2.5 py-1 rounded-full text-[10px] font-mono font-black uppercase bg-emerald-500/20 text-emerald-300 border border-emerald-500/30">
                                    ⚡ MERGE COMPLETED IN-PLACE
                                </span>
                                <span class="text-xs font-bold text-purple-200">Match #${matchId} Merged & Consolidated</span>
                            </div>
                            <span class="text-[11px] text-slate-400 font-mono">Static View (No Page Navigation)</span>
                        </div>
                        <div class="p-4 bg-white/10 rounded-2xl space-y-1 backdrop-blur-sm">
                            <div class="text-xs font-extrabold text-purple-300 uppercase tracking-wider">🎯 Target Primary Disaster Incident #${data.disaster.id}</div>
                            <h4 class="text-base font-extrabold text-white">${data.disaster.type || "Disaster"} — ${data.disaster.location}</h4>
                            <p class="text-xs text-slate-300 leading-relaxed">${data.disaster.description || "Consolidated primary incident record."}</p>
                        </div>
                        <div class="grid grid-cols-1 sm:grid-cols-3 gap-3 text-xs">
                            <div class="p-3 bg-white/10 rounded-xl">
                                <span class="text-[10px] text-purple-300 font-extrabold uppercase block">Aggregated Reports</span>
                                <span class="font-extrabold text-white text-sm font-mono">📊 ${data.disaster.corroborating_reports_count} Reports Combined</span>
                            </div>
                            <div class="p-3 bg-white/10 rounded-xl">
                                <span class="text-[10px] text-purple-300 font-extrabold uppercase block">Verified Affected</span>
                                <span class="font-extrabold text-white text-sm font-mono">👥 ${data.disaster.verified_people_affected} Citizens</span>
                            </div>
                            <div class="p-3 bg-white/10 rounded-xl">
                                <span class="text-[10px] text-purple-300 font-extrabold uppercase block">Combined Needs</span>
                                <span class="font-bold text-white truncate block">🆘 ${(data.disaster.combined_assistance_needed || []).join(", ") || "General Aid"}</span>
                            </div>
                        </div>
                        <div class="flex items-center justify-between pt-2 border-t border-white/10">
                            <span class="text-[11px] text-slate-400">Card updated statically. You stay on this page.</span>
                            <button type="button" onclick="this.closest('.command-card').remove()" class="px-3.5 py-1.5 bg-slate-800 hover:bg-slate-700 text-white rounded-xl text-xs font-bold transition">
                                Dismiss Card ✕
                            </button>
                        </div>
                    `;
                } else if (data.action === "KEEP_SEPARATE") {
                    card.className = "command-card p-6 space-y-4 border-l-4 border-l-blue-500 bg-gradient-to-r from-slate-900 to-blue-950 text-white rounded-3xl shadow-xl transition-all";
                    card.innerHTML = `
                        <div class="flex items-center justify-between">
                            <span class="px-2.5 py-1 rounded-full text-[10px] font-mono font-black uppercase bg-blue-500/20 text-blue-300 border border-blue-500/30">
                                🛡️ PROMOTED TO NEW INCIDENT #${data.disaster.id}
                            </span>
                            <button type="button" onclick="this.closest('.command-card').remove()" class="text-slate-400 hover:text-white text-xs font-bold">✕ Dismiss</button>
                        </div>
                        <div class="text-xs font-bold text-white">Match #${matchId} Verified as Independent Incident #${data.disaster.id} (${data.disaster.type} at ${data.disaster.location}).</div>
                    `;
                } else if (data.action === "REJECT") {
                    card.remove();
                }
            }

            // Restore scroll position immediately so window position remains frozen
            window.scrollTo({ top: scrollPos, behavior: 'instant' });

        } else {
            const err = await res.json();
            showToast(`Failed: ${err.detail || "Action error"}`, "error");
        }
    } catch (err) {
        showToast("Error processing verification decision.", "error");
    }
}

async function updateDisasterStatus(id, newStatus) {
    if (!newStatus) return;
    if (!currentUser || !["AUTHORITY_VERIFIED", "ADMIN"].includes(currentUser.role)) {
        showToast("Forbidden: Verified Authority credentials required to change incident status.", "error");
        return;
    }
    try {
        const res = await fetch(`${API_BASE}/disasters/${id}/status`, {
            method: "PATCH",
            headers: authHeaders(),
            body: JSON.stringify({ status: newStatus })
        });
        if (res.ok) {
            showToast(`Incident #${id} updated to ${newStatus}`);
            loadDisasters();
            loadOverview();
        } else {
            const err = await res.json();
            showToast(`Failed: ${err.detail || "Status update error"}`, "error");
        }
    } catch (err) {
        showToast("Error updating incident status", "error");
    }
}

// ==================== SHELTERS MODULE ====================
async function loadShelters() {
    const openOnly = document.getElementById("filter-shelter-open")?.checked || false;
    const url = `${API_BASE}/shelters/?open_only=${openOnly}`;

    try {
        const res = await fetch(url);
        currentShelters = await res.json();
        OfflineManager.setCache("shelters", currentShelters);
        renderSheltersGrid(currentShelters);
    } catch (err) {
        const cached = OfflineManager.getCache("shelters") || [];
        renderSheltersGrid(cached);
    }
}

function renderSheltersGrid(shelters) {
    const grid = document.getElementById("shelters-grid");
    if (shelters.length === 0) {
        grid.innerHTML = `<div class="col-span-full p-12 text-center text-slate-400">No emergency relief camps match filters.</div>`;
        return;
    }

    const role = ((currentUser && currentUser.role) || localStorage.getItem("selected_role") || "USER").toUpperCase();
    const isAuthority = (role === "AUTHORITY" || role === "AUTHORITY_VERIFIED" || role === "ADMIN");

    grid.innerHTML = shelters.map(s => {
        const percent = Math.min(100, Math.round((s.current_occupancy / s.capacity) * 100));
        const occupancyColor = percent >= 90 ? "bg-red-600" : percent >= 60 ? "bg-amber-500" : "bg-emerald-500";
        const statusClass = s.status === "Open" ? "bg-emerald-100 text-emerald-800" :
                            s.status === "Full" ? "bg-red-100 text-red-800" : "bg-slate-100 text-slate-800";
        const contactPhone = s.contact_number || s.contact_phone || "";
        const occupancyControls = isAuthority
            ? `<div class="flex items-center gap-1.5">
                <button onclick="changeOccupancy(${s.id}, ${s.current_occupancy - 10})" class="px-2.5 py-1 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg font-bold transition" title="Decrease by 10">-10</button>
                <button onclick="changeOccupancy(${s.id}, ${s.current_occupancy + 10})" class="px-2.5 py-1 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-lg font-bold transition" title="Increase by 10">+10</button>
               </div>`
            : "";

        return `
            <div class="command-card p-6">
                <div class="flex items-start justify-between">
                    <div>
                        <h3 class="font-extrabold text-slate-950 text-base leading-snug">${s.name}</h3>
                        <p class="text-xs text-slate-500 mt-1">📍 ${s.location}</p>
                    </div>
                    <span class="text-[10px] px-2.5 py-1 rounded-full font-extrabold uppercase ${statusClass}">${s.status}</span>
                </div>

                <div class="mt-5">
                    <div class="flex justify-between text-xs font-bold text-slate-700 mb-1.5">
                        <span>Occupancy: ${s.current_occupancy} / ${s.capacity} beds</span>
                        <span>${percent}%</span>
                    </div>
                    <div class="w-full h-2.5 bg-slate-100 rounded-full overflow-hidden">
                        <div class="h-full rounded-full transition-all duration-500 ${occupancyColor}" style="width: ${percent}%"></div>
                    </div>
                </div>

                <div class="mt-5 pt-4 border-t border-slate-100 flex items-center justify-between text-xs">
                    <a href="tel:${contactPhone}" class="text-blue-600 font-bold hover:underline">📞 ${contactPhone || "No contact"}</a>
                    ${occupancyControls}
                </div>
            </div>
        `;
    }).join("");
}

async function registerShelter(e) {
    e.preventDefault();
    const latVal = document.getElementById("shelter-lat").value;
    const lngVal = document.getElementById("shelter-lng").value;

    const payload = {
        name: document.getElementById("shelter-name").value,
        location: document.getElementById("shelter-location").value,
        latitude: latVal ? parseFloat(latVal) : null,
        longitude: lngVal ? parseFloat(lngVal) : null,
        capacity: parseInt(document.getElementById("shelter-capacity").value),
        current_occupancy: parseInt(document.getElementById("shelter-occupancy").value || 0),
        contact_number: document.getElementById("shelter-contact").value
    };

    if (!navigator.onLine) {
        OfflineManager.addToQueue({
            url: `${API_BASE}/shelters/`,
            method: "POST",
            payload: payload,
            label: `Register Shelter: ${payload.name}`
        });
        closeModal("modal-register-shelter");
        document.getElementById("form-register-shelter").reset();
        return;
    }

    try {
        const res = await fetch(`${API_BASE}/shelters/`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });
        if (res.ok) {
            showToast("Relief shelter camp registered!");
            closeModal("modal-register-shelter");
            document.getElementById("form-register-shelter").reset();
            loadShelters();
            loadOverview();
        }
    } catch (err) {
        OfflineManager.addToQueue({
            url: `${API_BASE}/shelters/`,
            method: "POST",
            payload: payload,
            label: `Register Shelter: ${payload.name}`
        });
        closeModal("modal-register-shelter");
        document.getElementById("form-register-shelter").reset();
    }
}

async function changeOccupancy(id, newOccupancy) {
    if (newOccupancy < 0) newOccupancy = 0;
    try {
        const res = await fetch(`${API_BASE}/shelters/${id}/occupancy`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ current_occupancy: newOccupancy })
        });
        if (res.ok) {
            showToast("Camp occupancy updated!");
            loadShelters();
            loadOverview();
        }
    } catch (err) {
        showToast("Error updating occupancy count", "error");
    }
}

// ==================== RESOURCES & REQUESTS MODULE ====================
async function loadResources() {
    try {
        const [invRes, reqRes] = await Promise.all([
            fetch(`${API_BASE}/resources/`),
            fetch(`${API_BASE}/resources/requests/`)
        ]);

        currentResources = await invRes.json();
        currentRequests = await reqRes.json();

        OfflineManager.setCache("resources", currentResources);
        OfflineManager.setCache("requests", currentRequests);

        renderResourcesTables(currentResources, currentRequests);

    } catch (err) {
        const cachedInv = OfflineManager.getCache("resources") || [];
        const cachedReq = OfflineManager.getCache("requests") || [];
        renderResourcesTables(cachedInv, cachedReq);
    }
}

function renderResourcesTables(inventory, requests) {
    const invBody = document.getElementById("inventory-table-body");
    invBody.innerHTML = inventory.length === 0
        ? `<tr><td colspan="5" class="p-6 text-center text-slate-400">No warehouse stock items recorded.</td></tr>`
        : inventory.map(r => `
            <tr class="hover:bg-slate-50/80 transition">
                <td class="px-6 py-4 font-bold text-slate-950">${r.name || r.item_name}</td>
                <td class="px-6 py-4"><span class="text-[10px] px-2.5 py-1 bg-blue-50 text-blue-700 font-bold rounded-full">${r.category || "General"}</span></td>
                <td class="px-6 py-4 font-mono font-extrabold text-slate-900">${r.quantity_available ?? 0} <span class="text-xs font-normal text-slate-500">units</span></td>
                <td class="px-6 py-4 text-slate-600 font-medium">${r.delivery_location || "—"}</td>
                <td class="px-6 py-4 text-slate-400 font-mono">${r.created_at ? new Date(r.created_at).toLocaleDateString() : "—"}</td>
            </tr>
        `).join("");

    const reqBody = document.getElementById("requests-table-body");
    reqBody.innerHTML = requests.length === 0
        ? `<tr><td colspan="5" class="p-6 text-center text-slate-400">No supply requests in queue.</td></tr>`
        : requests.map(req => `
            <tr class="hover:bg-slate-50/80 transition">
                <td class="px-6 py-4 font-mono font-bold text-slate-500">#${req.id}</td>
                <td class="px-6 py-4">
                    <div class="font-extrabold text-slate-900">${req.item_name || req.name}</div>
                    <div class="text-[11px] text-slate-500 mt-0.5">Qty: ${req.quantity_requested ?? "?"} &bull; Delivery: ${req.delivery_location || "—"}</div>
                </td>
                <td class="px-6 py-4"><span class="text-[10px] px-2.5 py-1 rounded-full font-extrabold uppercase ${getSeverityBadge(req.urgency || "High")}">${req.urgency || "High"}</span></td>
                <td class="px-6 py-4"><span class="text-[10px] px-2.5 py-1 rounded-xl font-extrabold ${getStatusBadge(req.status)}">${req.status}</span></td>
                <td class="px-6 py-4 text-right">
                    <select onchange="updateRequestStatus(${req.id}, this.value)" class="text-xs border border-slate-200 rounded-xl px-2.5 py-1 bg-white font-medium text-slate-700 focus:ring-2 focus:ring-blue-500 focus:outline-none">
                        <option value="">Fulfill Action...</option>
                        <option value="Approved">Approve Request</option>
                        <option value="Dispatched">Dispatch Supplies</option>
                        <option value="Fulfilled">Mark Fulfilled</option>
                        <option value="Rejected">Reject Request</option>
                    </select>
                </td>
            </tr>
        `).join("");
}


async function addResource(e) {
    e.preventDefault();
    const qty = parseInt(document.getElementById("resource-quantity").value) || 0;
    const unit = document.getElementById("resource-unit").value || "units";
    const name = document.getElementById("resource-name").value;
    const payload = {
        item_name: `${name} (${unit})`,
        name: `${name} (${unit})`,
        category: document.getElementById("resource-category").value,
        quantity_available: qty,
        delivery_location: document.getElementById("resource-location").value
    };

    try {
        const res = await fetch(`${API_BASE}/resources/`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });
        if (res.ok) {
            showToast("Relief stock logged into depot inventory!");
            closeModal("modal-add-resource");
            document.getElementById("form-add-resource").reset();
            loadResources();
        } else {
            const err = await res.json().catch(() => ({}));
            showToast(`Error: ${err.detail || "Failed to add stock"}`, "error");
        }
    } catch (err) {
        showToast("Network error adding inventory record", "error");
    }
}

async function submitResourceRequest(e) {
    e.preventDefault();
    const disasterId = document.getElementById("request-disaster-id").value;
    const payload = {
        item_name: document.getElementById("request-item-name").value,
        quantity_requested: parseInt(document.getElementById("request-quantity").value),
        urgency: document.getElementById("request-urgency").value,
        delivery_location: document.getElementById("request-location").value,
        disaster_id: disasterId ? parseInt(disasterId) : null
    };

    if (!navigator.onLine) {
        OfflineManager.addToQueue({
            url: `${API_BASE}/resources/requests/`,
            method: "POST",
            payload: payload,
            label: `Supply Request: ${payload.item_name}`
        });
        closeModal("modal-request-resource");
        document.getElementById("form-request-resource").reset();
        return;
    }

    try {
        const res = await fetch(`${API_BASE}/resources/requests/`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(payload)
        });
        if (res.ok) {
            showToast("Emergency relief request submitted!");
            closeModal("modal-request-resource");
            document.getElementById("form-request-resource").reset();
            loadResources();
            loadOverview();
        }
    } catch (err) {
        OfflineManager.addToQueue({
            url: `${API_BASE}/resources/requests/`,
            method: "POST",
            payload: payload,
            label: `Supply Request: ${payload.item_name}`
        });
        closeModal("modal-request-resource");
        document.getElementById("form-request-resource").reset();
    }
}

async function updateRequestStatus(id, newStatus) {
    if (!newStatus) return;
    try {
        const res = await fetch(`${API_BASE}/resources/requests/${id}/status`, {
            method: "PATCH",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ status: newStatus })
        });
        if (res.ok) {
            showToast(`Supply request #${id} marked as ${newStatus}`);
            loadResources();
            loadOverview();
        }
    } catch (err) {
        showToast("Error updating request status", "error");
    }
}

// ==================== IMD ALERTS & INGESTION MODULE ====================
async function loadAlerts() {
    try {
        const res = await fetch(`${API_BASE}/alerts/`);
        currentAlerts = await res.json();
        OfflineManager.setCache("alerts", currentAlerts);
        renderAlertsCards(currentAlerts);
    } catch (err) {
        const cached = OfflineManager.getCache("alerts") || [];
        renderAlertsCards(cached);
    }
}

async function fetchIMDStatus() {
    try {
        const res = await fetch(`${API_BASE}/alerts/imd/status`);
        const statusData = await res.json();

        document.getElementById("imd-mode-badge").textContent = statusData.provider_mode.toUpperCase();
        document.getElementById("imd-ingested-count").textContent = statusData.total_ingested_count;
        document.getElementById("imd-dedup-count").textContent = statusData.total_deduplicated_count;
        document.getElementById("imd-status-text").textContent = `Status: ${statusData.last_status} (Polled every ${statusData.polling_interval_seconds}s)`;
    } catch (err) {
        console.warn("Could not fetch IMD status");
    }
}

async function triggerIMDIngestion() {
    if (!currentUser || !["AUTHORITY_VERIFIED", "ADMIN"].includes(currentUser.role)) {
        showToast("Forbidden: Verified Authority credentials required to trigger IMD ingestion.", "error");
        return;
    }
    showToast("Triggering IMD alert ingestion cycle...", "info");
    try {
        const res = await fetch(`${API_BASE}/alerts/imd/ingest`, {
            method: "POST",
            headers: authHeaders()
        });
        const result = await res.json();
        showToast(`IMD Ingest: ${result.ingested} new, ${result.updated} updated, ${result.deduplicated} deduplicated`, "success");
        loadAlerts();
        fetchIMDStatus();
        loadOverview();
    } catch (err) {
        showToast("Error triggering IMD ingestion", "error");
    }
}

// ==================== LOCATION-AWARE EMERGENCY WARNING CONTROLLER ====================
let userLocationProfile = JSON.parse(localStorage.getItem("user_location_profile") || '{"state":"", "city":"", "lat":null, "lng":null}');
let alertScopeMode = localStorage.getItem("alert_scope_mode") || "nearby"; // "nearby" vs "all"

function updateUserLocationUI() {
    const badge = document.getElementById("user-location-badge");
    if (badge) {
        if (userLocationProfile.state) {
            badge.textContent = `📍 Location: ${userLocationProfile.city ? userLocationProfile.city + ', ' : ''}${userLocationProfile.state}`;
            badge.className = "px-2.5 py-0.5 rounded-full bg-emerald-600 text-white font-bold text-[10px]";
        } else {
            badge.textContent = "Location: Not Detected (Click to set)";
            badge.className = "px-2.5 py-0.5 rounded-full bg-slate-900 text-white font-mono text-[10px] font-bold";
        }
    }

    const btnNearby = document.getElementById("alert-scope-nearby");
    const btnAll = document.getElementById("alert-scope-all");
    if (btnNearby && btnAll) {
        if (alertScopeMode === "nearby") {
            btnNearby.className = "px-3 py-1.5 rounded-lg bg-slate-900 text-white shadow-sm transition font-bold";
            btnAll.className = "px-3 py-1.5 rounded-lg text-slate-600 hover:text-slate-900 transition font-bold";
        } else {
            btnAll.className = "px-3 py-1.5 rounded-lg bg-slate-900 text-white shadow-sm transition font-bold";
            btnNearby.className = "px-3 py-1.5 rounded-lg text-slate-600 hover:text-slate-900 transition font-bold";
        }
    }
}

function setAlertScope(scope) {
    alertScopeMode = scope;
    localStorage.setItem("alert_scope_mode", scope);
    updateUserLocationUI();
    loadAlerts();
}

function detectUserLocationForAlerts() {
    if (!navigator.geolocation) {
        showToast("GPS not supported by device browser. Please enter location manually.", "warning");
        return;
    }
    showToast("Detecting your location & state for localized warnings...", "info");
    navigator.geolocation.getCurrentPosition(
        async (pos) => {
            const lat = pos.coords.latitude;
            const lng = pos.coords.longitude;
            
            let state = "";
            let city = "";
            
            // Indian state coordinate fallback heuristics
            if (lat >= 8.0 && lat <= 12.8 && lng >= 74.8 && lng <= 77.5) { state = "Kerala"; city = "Ernakulam"; }
            else if (lat >= 24.0 && lat <= 28.2 && lng >= 89.5 && lng <= 96.0) { state = "Assam"; city = "Guwahati"; }
            else if (lat >= 17.8 && lat <= 22.5 && lng >= 81.3 && lng <= 87.5) { state = "Odisha"; city = "Paradip"; }
            else if (lat >= 18.5 && lat <= 20.2 && lng >= 72.7 && lng <= 73.5) { state = "Maharashtra"; city = "Mumbai"; }
            else if (lat >= 28.4 && lat <= 28.9 && lng >= 76.8 && lng <= 77.4) { state = "Delhi"; city = "New Delhi"; }
            else if (lat >= 20.1 && lat <= 24.7 && lng >= 68.0 && lng <= 74.5) { state = "Gujarat"; city = "Mandvi"; }
            else if (lat >= 29.5 && lat <= 31.5 && lng >= 78.0 && lng <= 80.5) { state = "Uttarakhand"; city = "Chamoli"; }
            else { state = "Kerala"; city = "Aluva"; }

            userLocationProfile = { state, city, lat: lat.toFixed(4), lng: lng.toFixed(4) };
            localStorage.setItem("user_location_profile", JSON.stringify(userLocationProfile));
            showToast(`Location detected: ${city}, ${state}`, "success");
            updateUserLocationUI();
            loadAlerts();
        },
        (err) => {
            userLocationProfile = { state: "Kerala", city: "Ernakulam", lat: "10.1076", lng: "76.3516" };
            localStorage.setItem("user_location_profile", JSON.stringify(userLocationProfile));
            showToast("GPS set to Kerala (Demo Profile).", "info");
            updateUserLocationUI();
            loadAlerts();
        },
        { enableHighAccuracy: true, timeout: 5000 }
    );
}

function isAlertMatchingUserLocation(alert) {
    if (!userLocationProfile.state) return true;
    const locState = (userLocationProfile.state || "").toLowerCase();
    const locCity = (userLocationProfile.city || "").toLowerCase();
    const target = (alert.target_region || "").toLowerCase();
    const title = (alert.title || "").toLowerCase();
    const msg = (alert.message || "").toLowerCase();

    return target.includes(locState) || (locCity && target.includes(locCity)) ||
           title.includes(locState) || msg.includes(locState);
}

function renderAlertsCards(alerts) {
    updateUserLocationUI();
    const container = document.getElementById("alerts-container");
    if (!container) return;

    if (!alerts || alerts.length === 0) {
        container.innerHTML = `<div class="col-span-full p-12 text-center text-slate-400">No warning bulletins posted.</div>`;
        return;
    }

    let displayAlerts = alerts;
    const hasLocation = Boolean(userLocationProfile.state);

    if (alertScopeMode === "nearby" && hasLocation) {
        displayAlerts = alerts.filter(a => isAlertMatchingUserLocation(a));
    }

    if (displayAlerts.length === 0) {
        container.innerHTML = `
            <div class="col-span-full p-10 bg-emerald-50 border border-emerald-200 rounded-3xl text-center space-y-3">
                <div class="text-4xl">🟢</div>
                <h3 class="text-base font-black text-emerald-950">No Active Emergency Warnings for ${userLocationProfile.state}</h3>
                <p class="text-xs text-emerald-800 font-medium">No red or orange alerts published for your region right now.</p>
                <button onclick="setAlertScope('all')" class="px-4 py-2 bg-slate-900 text-white rounded-xl text-xs font-bold shadow-sm">
                    🌐 View All India Bulletins (${alerts.length})
                </button>
            </div>`;
        return;
    }

    container.innerHTML = displayAlerts.map(a => {
        const isNearby = isAlertMatchingUserLocation(a);
        const regionBadgeHtml = isNearby ? `
            <span class="text-[10px] px-2.5 py-0.5 rounded-full font-black bg-red-600 text-white uppercase shadow-sm animate-pulse">
                📍 IN YOUR REGION
            </span>
        ` : `
            <span class="text-[10px] px-2.5 py-0.5 rounded-full font-bold bg-slate-200 text-slate-700 uppercase">
                🌐 Other Region
            </span>
        `;

        const isAuthUser = currentUser && (currentUser.role === "ADMIN" || currentUser.role === "AUTHORITY_VERIFIED");
        return `
            <div class="command-card p-6 ${isNearby ? "border-2 border-red-500 shadow-xl bg-gradient-to-br from-white to-red-50/20" : "border-slate-200/80 opacity-80"}">
                <div class="flex items-start justify-between gap-3">
                    <div>
                        <div class="flex items-center gap-2 flex-wrap mb-2">
                            ${regionBadgeHtml}
                            <span class="text-[10px] px-2.5 py-0.5 rounded-full font-extrabold uppercase ${
                                a.severity.includes("Critical") ? "bg-red-600 text-white" :
                                a.severity.includes("Warning") ? "bg-orange-100 text-orange-900" : "bg-blue-100 text-blue-900"
                            }">${a.severity}</span>
                            <span class="text-xs font-bold ${a.is_active ? "text-emerald-600" : "text-slate-400"}">
                                ${a.is_active ? (isAuthUser ? "● BROADCAST ACTIVE" : "● ACTIVE WARNING") : "○ ARCHIVED"}
                            </span>
                        </div>
                        <h3 class="font-extrabold text-slate-950 text-lg">${a.title}</h3>
                        <p class="text-xs text-slate-600 font-bold mt-1">📍 Target Region: <span class="text-slate-900">${a.target_region}</span> &bull; ${new Date(a.created_at).toLocaleString("en-IN")}</p>
                    </div>
                </div>

                <p class="text-slate-800 text-xs md:text-sm mt-3 bg-slate-50 p-4 rounded-2xl border border-slate-200 leading-relaxed font-medium">${a.message}</p>

                <div class="mt-4 pt-3 border-t border-slate-100 flex items-center justify-between">
                    <button onclick="navigator.clipboard.writeText('${a.title}: ${a.message}'); showToast('Alert text copied to clipboard!', 'info');" class="text-xs font-bold text-slate-500 hover:text-slate-800">
                        📋 Copy Text
                    </button>
                    ${a.is_active ? (isAuthUser ? `
                        <button onclick="deactivateAlert(${a.id})" class="px-3.5 py-1.5 bg-red-50 text-red-700 hover:bg-red-100 rounded-xl text-xs font-bold transition">
                            Deactivate Alert
                        </button>
                    ` : `<span class="text-xs text-emerald-600 font-bold">● Active Bulletin</span>`) : `<span class="text-xs text-slate-400 font-semibold">Deactivated</span>`}
                </div>
            </div>
        `;
    }).join("");
}

async function broadcastAlert(e) {
    e.preventDefault();
    if (!currentUser || !["AUTHORITY_VERIFIED", "ADMIN"].includes(currentUser.role)) {
        showToast("Forbidden: Verified Authority credentials required to broadcast alerts.", "error");
        return;
    }
    const payload = {
        title: document.getElementById("alert-title").value,
        severity: document.getElementById("alert-severity").value,
        target_region: document.getElementById("alert-region").value,
        message: document.getElementById("alert-message").value
    };

    try {
        const res = await fetch(`${API_BASE}/alerts/`, {
            method: "POST",
            headers: authHeaders(),
            body: JSON.stringify(payload)
        });
        if (res.ok) {
            showToast("Emergency alert broadcasted!");
            closeModal("modal-broadcast-alert");
            document.getElementById("form-broadcast-alert").reset();
            loadAlerts();
            loadOverview();
        } else {
            const err = await res.json();
            showToast(`Failed: ${err.detail || "Alert error"}`, "error");
        }
    } catch (err) {
        showToast("Error broadcasting alert", "error");
    }
}

async function deactivateAlert(id) {
    if (!currentUser || !["AUTHORITY_VERIFIED", "ADMIN"].includes(currentUser.role)) {
        showToast("Forbidden: Verified Authority credentials required to deactivate alerts.", "error");
        return;
    }
    try {
        const res = await fetch(`${API_BASE}/alerts/${id}/deactivate`, {
            method: "PATCH",
            headers: authHeaders()
        });
        if (res.ok) {
            showToast("Alert archived.");
            loadAlerts();
            loadOverview();
        }
    } catch (err) {
        showToast("Error deactivating alert", "error");
    }
}

// ==================== OFFLINE TELEPHONY & SMS/IVR HUB ====================
async function loadCommunicationLogs() {
    try {
        const res = await fetch(`${API_BASE}/communication/logs?limit=50`);
        currentCommLogs = await res.json();
        renderCommunicationLogsTable(currentCommLogs);
    } catch (err) {
        console.warn("Could not fetch communication logs");
    }
}

function renderCommunicationLogsTable(logs) {
    const tbody = document.getElementById("comm-logs-table-body");
    if (!tbody) return;

    if (logs.length === 0) {
        tbody.innerHTML = `<tr><td colspan="7" class="p-8 text-center text-slate-400">No telephony interactions logged yet. Use the simulators above to test.</td></tr>`;
        return;
    }

    tbody.innerHTML = logs.map(l => `
        <tr class="hover:bg-slate-50/80 transition">
            <td class="px-6 py-4 font-mono font-bold text-slate-500">#${l.id}</td>
            <td class="px-6 py-4">
                <span class="text-[10px] px-2.5 py-1 rounded-full font-bold uppercase ${
                    l.channel === "SMS" ? "bg-blue-100 text-blue-800" : "bg-purple-100 text-purple-800"
                }">${l.channel}</span>
            </td>
            <td class="px-6 py-4 font-mono text-slate-800 font-bold">${l.from_number}</td>
            <td class="px-6 py-4 font-mono text-xs text-slate-700">${l.command_or_input}</td>
            <td class="px-6 py-4 text-slate-600 max-w-xs truncate text-[11px]">${l.response_text || '—'}</td>
            <td class="px-6 py-4">
                <span class="text-[10px] px-2 py-0.5 rounded font-bold ${l.status === 'SUCCESS' ? 'bg-emerald-100 text-emerald-800' : 'bg-red-100 text-red-800'}">${l.status}</span>
            </td>
            <td class="px-6 py-4 font-mono text-slate-400 text-[11px]">${new Date(l.created_at).toLocaleTimeString()}</td>
        </tr>
    `).join("");
}

function setSMSInput(cmd) {
    document.getElementById("sms-body").value = cmd;
}

async function handleTestSMS(e) {
    e.preventDefault();
    const from_number = document.getElementById("sms-sender").value;
    const message = document.getElementById("sms-body").value;
    const box = document.getElementById("sms-response-box");

    box.classList.remove("hidden");
    box.textContent = "Transmitting SMS to backend command gateway...";

    try {
        const res = await fetch(`${API_BASE}/communication/test-sms`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ from_number, message })
        });
        const data = await res.json();
        box.textContent = `[INCOMING REPLY FROM GATEWAY]:
${data.reply}`;
        showToast("SMS command executed by backend!", "success");
        loadCommunicationLogs();
        loadOverview();
        if (data.related_disaster_id) {
            showToast(`New Incident #${data.related_disaster_id} logged via SMS!`, "warning");
        }
    } catch (err) {
        box.textContent = "Error communicating with backend SMS gateway.";
    }
}

async function handleTestIVR(digits) {
    const box = document.getElementById("ivr-response-box");
    box.innerHTML = `<div class="text-amber-400 font-bold">Connecting IVR call session... [Keypad: ${digits || 'Start Call'}]</div>`;

    try {
        const res = await fetch(`${API_BASE}/communication/test-ivr`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({
                from_number: "+919876543210",
                call_sid: "CALL-SIMULATOR-001",
                digits: digits
            })
        });
        const data = await res.json();
        box.innerHTML = `
            <div class="text-emerald-400 font-bold">// IVR Action: ${data.action}</div>
            <div class="text-slate-200 mt-1 leading-relaxed">🔊 "${data.speech}"</div>
            <div class="text-slate-500 text-[10px] mt-2 pt-2 border-t border-slate-800">TwiML Action: ${data.twiml.replace(/</g, '&lt;').replace(/>/g, '&gt;')}</div>
        `;
        loadCommunicationLogs();
    } catch (err) {
        box.innerHTML = `<div class="text-red-400">IVR webhook communication error.</div>`;
    }
}

// ==================== GLOBAL SEARCH ====================
function handleGlobalSearch(query) {
    const q = (query || "").toLowerCase().trim();
    if (!q) {
        if (activeTab === "disasters") renderDisastersTable(currentDisasters);
        if (activeTab === "shelters") renderSheltersGrid(currentShelters);
        return;
    }

    if (activeTab === "disasters") {
        const filtered = currentDisasters.filter(d => 
            d.type.toLowerCase().includes(q) ||
            d.location.toLowerCase().includes(q) ||
            (d.description && d.description.toLowerCase().includes(q))
        );
        renderDisastersTable(filtered);
    } else if (activeTab === "shelters") {
        const filtered = currentShelters.filter(s =>
            s.name.toLowerCase().includes(q) ||
            s.location.toLowerCase().includes(q)
        );
        renderSheltersGrid(filtered);
    }
}

// ==================== BADGE HELPERS ====================
function getSeverityBadge(sev) {
    const s = (sev || "").toLowerCase();
    if (s.includes("critical")) return "bg-red-100 text-red-800 border border-red-200";
    if (s.includes("high"))     return "bg-orange-100 text-orange-800 border border-orange-200";
    if (s.includes("medium"))   return "bg-amber-100 text-amber-800 border border-amber-200";
    return "bg-blue-100 text-blue-800 border border-blue-200";
}

function getStatusBadge(status) {
    const s = (status || "").toLowerCase();
    if (s === "resolved" || s === "fulfilled" || s === "approved") return "bg-emerald-100 text-emerald-800";
    if (s === "in progress" || s === "dispatched") return "bg-blue-100 text-blue-800";
    if (s === "verified") return "bg-purple-100 text-purple-800";
    if (s === "rejected") return "bg-red-100 text-red-800";
    return "bg-amber-100 text-amber-800";
}

// ==================== AUTHENTICATION CONTROLLER (CATEGORY 1) ====================
function authHeaders(options = {}) {
    const headers = {};
    if (!options.skipContentType) {
        headers["Content-Type"] = "application/json";
    }
    if (authToken) {
        headers["Authorization"] = `Bearer ${authToken}`;
    }
    return headers;
}

// Mock user profiles for each role
const ROLE_PROFILES = {
    USER: {
        id: 1,
        name: "Citizen User",
        email: "citizen@disasterhub.in",
        role: "USER",
        phone_number: "+919876543210",
        avatar_url: "https://images.unsplash.com/photo-1570295999919-56ceb5ecca61?w=150"
    },
    AUTHORITY_VERIFIED: {
        id: 2,
        name: "Authority Officer",
        email: "authority@ndrf.gov.in",
        role: "AUTHORITY_VERIFIED",
        phone_number: "+919811122233",
        avatar_url: "https://images.unsplash.com/photo-1506794778202-cad84cf45f1d?w=150"
    },
    ADMIN: {
        id: 3,
        name: "National Administrator",
        email: "admin@disasterhub.gov.in",
        role: "ADMIN",
        phone_number: "+919999888877",
        avatar_url: "https://images.unsplash.com/photo-1500648767791-00dcc994a43e?w=150"
    }
};

async function checkAuthSession() {
    let selectedRole = localStorage.getItem("selected_role");

    // If no role is set, default to USER (no redirect, app must always work)
    if (!selectedRole || !ROLE_PROFILES[selectedRole]) {
        selectedRole = "USER";
        localStorage.setItem("selected_role", selectedRole);
    }

    const user = ROLE_PROFILES[selectedRole];
    currentUser = user;
    authToken = null;
    localStorage.setItem("auth_user", JSON.stringify(user));
    updateAuthUI(user);
    handleRoleRouting(user);
}

function handleRoleRouting(user) {
    if (!user) return;
    const hash = (window.location.hash || "").toLowerCase();
    const role = (user.role || "USER").toUpperCase();

    if (hash.includes("authority") && (role === "AUTHORITY_VERIFIED" || role === "ADMIN")) {
        switchTab("authority-dashboard");
    } else if (hash.includes("citizen") || role === "USER") {
        if (activeTab === "overview" && hash.includes("citizen")) {
            switchTab("user-dashboard");
        }
    }
}

function updateAuthUI(user) {
    const unauthEl = document.getElementById("auth-unauthenticated");
    const authEl = document.getElementById("auth-authenticated");
    const nameEl = document.getElementById("user-display-name");
    const roleEl = document.getElementById("user-role-badge");
    const avatarEl = document.getElementById("user-avatar");
    const adminNavGroup = document.getElementById("nav-group-admin");
    const authorityNavGroup = document.getElementById("nav-group-authority");
    const applyCard = document.getElementById("sidebar-authority-apply-card");

    if (user) {
        if (unauthEl) unauthEl.classList.add("hidden");
        if (authEl) authEl.classList.remove("hidden");
        if (nameEl) nameEl.textContent = user.name || user.email;
        const defaultAvatar = "data:image/svg+xml;utf8,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><circle cx='50' cy='50' r='50' fill='%232563eb'/><text x='50' y='62' font-size='40' text-anchor='middle' fill='white' font-family='sans-serif'>👤</text></svg>";
        if (avatarEl) avatarEl.src = defaultAvatar;

        const role = (user.role || "USER").toUpperCase();
        if (roleEl) {
            roleEl.textContent = role;
            if (role === "ADMIN") {
                roleEl.className = "text-[9px] font-black uppercase px-1 rounded bg-blue-500/20 text-blue-300 border border-blue-500/30 font-mono";
            } else if (role === "AUTHORITY_VERIFIED") {
                roleEl.className = "text-[9px] font-black uppercase px-1 rounded bg-purple-500/20 text-purple-300 border border-purple-500/30 font-mono";
            } else if (role === "AUTHORITY_PENDING") {
                roleEl.className = "text-[9px] font-black uppercase px-1 rounded bg-amber-500/20 text-amber-300 border border-amber-500/30 font-mono";
            } else {
                roleEl.className = "text-[9px] font-black uppercase px-1 rounded bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 font-mono";
            }
        }

        // Populate User Profile Modal elements
        const mpAvatar = document.getElementById("modal-profile-avatar");
        const mpName = document.getElementById("modal-profile-name");
        const mpEmail = document.getElementById("modal-profile-email");
        const mpBadge = document.getElementById("modal-profile-role-badge");
        const mpPhone = document.getElementById("modal-profile-phone");
        const mpState = document.getElementById("modal-profile-state");
        const mpDistrict = document.getElementById("modal-profile-district");
        const mpEmergency = document.getElementById("modal-profile-emergency");

        if (mpAvatar) mpAvatar.src = user.avatar_url || "https://images.unsplash.com/photo-1534528741775-53994a69daeb?w=150";
        if (mpName) mpName.textContent = user.name || "Citizen";
        if (mpEmail) mpEmail.textContent = user.email || "--";
        if (mpBadge) {
            mpBadge.textContent = role;
            if (role === "ADMIN") mpBadge.className = "inline-block text-[9px] font-black uppercase px-2 py-0.5 rounded bg-blue-100 text-blue-800 border border-blue-200";
            else if (role === "AUTHORITY_VERIFIED") mpBadge.className = "inline-block text-[9px] font-black uppercase px-2 py-0.5 rounded bg-purple-100 text-purple-800 border border-purple-200";
            else if (role === "AUTHORITY_PENDING") mpBadge.className = "inline-block text-[9px] font-black uppercase px-2 py-0.5 rounded bg-amber-100 text-amber-800 border border-amber-200";
            else mpBadge.className = "inline-block text-[9px] font-black uppercase px-2 py-0.5 rounded bg-emerald-100 text-emerald-800 border border-emerald-200";
        }
        if (mpPhone) mpPhone.textContent = user.phone_number ? (user.phone_number.startsWith("+91") ? user.phone_number : `+91 ${user.phone_number}`) : "Not Provided";
        if (mpState) mpState.textContent = user.state || "--";
        if (mpDistrict) mpDistrict.textContent = user.district || "--";
        if (mpEmergency) {
            mpEmergency.textContent = user.emergency_contact_name ? `${user.emergency_contact_name} (${user.emergency_contact_phone || ''})` : "--";
        }

        // Show Authority & Admin Nav Groups
        const opsNavGroup = document.getElementById("nav-group-ops");
        if (opsNavGroup) {
            opsNavGroup.classList.toggle("hidden", !(role === "ADMIN" || role === "AUTHORITY_VERIFIED"));
        }
        if (authorityNavGroup) {
            authorityNavGroup.classList.toggle("hidden", !(role === "ADMIN" || role === "AUTHORITY_VERIFIED"));
        }
        if (adminNavGroup) {
            adminNavGroup.classList.toggle("hidden", role !== "ADMIN");
        }

        // Toggle Overview Authority Feeds
        const overviewAuthPanels = document.getElementById("overview-authority-panels");
        if (overviewAuthPanels) {
            overviewAuthPanels.classList.toggle("hidden", !(role === "ADMIN" || role === "AUTHORITY_VERIFIED"));
        }

        // Toggle Disaster Alerts Broadcast Controls & IMD Ribbon for User vs Authority
        const isAuth = role === "ADMIN" || role === "AUTHORITY_VERIFIED";
        const alertAuthControls = document.getElementById("alert-authority-controls");
        const imdStatusCard = document.getElementById("imd-status-card");
        const alertHeaderTitle = document.getElementById("alert-header-title");
        const alertHeaderSub = document.getElementById("alert-header-sub");

        if (alertAuthControls) alertAuthControls.classList.toggle("hidden", !isAuth);
        if (imdStatusCard) imdStatusCard.classList.toggle("hidden", !isAuth);
        if (alertHeaderTitle) {
            alertHeaderTitle.textContent = isAuth ? "Unified IMD Alert Ingestion & Warning Broadcasts" : "Disaster Alerts & Meteorological Warnings";
        }
        if (alertHeaderSub) {
            alertHeaderSub.textContent = isAuth ? "Official IMD/NDMA meteorological warnings with automated deduplication and lifecycle synchronization." : "Official IMD/NDMA meteorological warnings, weather bulletins, and emergency notices for your region.";
        }

        // Show Register Relief Camp & occupancy controls only for Authority/Admin
        const registerShelterBtn = document.getElementById("btn-register-shelter");
        if (registerShelterBtn) registerShelterBtn.classList.toggle("hidden", !isAuth);

        // Manage Authority Application Callout Card
        if (applyCard) {
            if (role === "ADMIN" || role === "AUTHORITY_VERIFIED") {
                applyCard.classList.add("hidden");
            } else if (role === "AUTHORITY_PENDING") {
                applyCard.classList.remove("hidden");
                applyCard.innerHTML = `
                    <div class="flex items-center gap-2">
                        <span class="text-sm animate-pulse">⏳</span>
                        <div class="text-[11px] font-bold text-amber-950">Application Pending</div>
                    </div>
                    <p class="text-[10px] text-amber-800 leading-snug">Your official responder credentials are under verification by the lead administrator.</p>
                `;
            } else {
                applyCard.classList.remove("hidden");
            }
        }

        // Pre-fill profile completion inputs
        const pName = document.getElementById("profile-name");
        const pPhone = document.getElementById("profile-phone");
        const pState = document.getElementById("profile-state");
        const pDist = document.getElementById("profile-district");
        
        if (pName && !pName.value) pName.value = user.name || "";
        if (pPhone && user.phone_number) {
            pPhone.value = user.phone_number.replace(/^\+91/, "");
        }
        if (pState && user.state) pState.value = user.state;
        if (pDist && user.district) pDist.value = user.district;

        // Fetch unread notifications
        fetchUnreadNotificationCount();

        // Check if mandatory phone is missing
        if (!user.phone_number || user.phone_number.trim().length < 10) {
            setTimeout(() => {
                openModal("modal-profile-completion");
            }, 600);
        }
    } else {
        if (authorityNavGroup) authorityNavGroup.classList.add("hidden");
        if (unauthEl) unauthEl.classList.remove("hidden");
        if (authEl) authEl.classList.add("hidden");
        if (adminNavGroup) adminNavGroup.classList.add("hidden");
        if (applyCard) applyCard.classList.remove("hidden");
    }
}

function openCompleteProfileModal() {
    if (currentUser) {
        const pName = document.getElementById("profile-name");
        const pPhone = document.getElementById("profile-phone");
        const pState = document.getElementById("profile-state");
        const pDist = document.getElementById("profile-district");
        const pEmName = document.getElementById("profile-emergency-name");
        const pEmPhone = document.getElementById("profile-emergency-phone");

        if (pName) pName.value = currentUser.name || "";
        if (pPhone && currentUser.phone_number) {
            pPhone.value = currentUser.phone_number.replace(/^\+91/, "").replace(/\s+/g, "");
        }
        if (pState && currentUser.state) pState.value = currentUser.state;
        if (pDist && currentUser.district) pDist.value = currentUser.district;
        if (pEmName && currentUser.emergency_contact_name) pEmName.value = currentUser.emergency_contact_name;
        if (pEmPhone && currentUser.emergency_contact_phone) pEmPhone.value = currentUser.emergency_contact_phone;
    }
    openModal("modal-profile-completion");
}

function handleProfileCompletion(e) {
    if (e) e.preventDefault();
    const name = document.getElementById("profile-name")?.value.trim();
    const phone = document.getElementById("profile-phone")?.value.trim();
    const state = document.getElementById("profile-state")?.value.trim();
    const dist = document.getElementById("profile-district")?.value.trim();
    const emName = document.getElementById("profile-emergency-name")?.value.trim();
    const emPhone = document.getElementById("profile-emergency-phone")?.value.trim();

    if (!phone || phone.length < 10) {
        showToast("Please enter a valid 10-digit mobile phone number.", "warning");
        return;
    }

    if (!currentUser) {
        currentUser = { role: "USER" };
    }

    currentUser.name = name || currentUser.name || "Citizen User";
    currentUser.phone_number = phone.startsWith("+91") ? phone : `+91${phone}`;
    currentUser.state = state || "";
    currentUser.district = dist || "";
    currentUser.emergency_contact_name = emName || "";
    currentUser.emergency_contact_phone = emPhone || "";

    localStorage.setItem("auth_user", JSON.stringify(currentUser));
    updateAuthUI(currentUser);
    closeModal("modal-profile-completion");
    showToast("Profile and emergency contact details updated successfully!", "success");
}

function openAuthorityApplicationModal() {
    if (currentUser && currentUser.role === "AUTHORITY_PENDING") {
        showToast("You already have an application under review.", "info");
        return;
    }
    if (currentUser && (currentUser.role === "AUTHORITY_VERIFIED" || currentUser.role === "ADMIN")) {
        showToast("You already possess verified operational authority privileges.", "info");
        return;
    }
    openModal("modal-authority-application");
}

async function handleAuthorityApplication(e) {
    if (e) e.preventDefault();

    const org = document.getElementById("auth-org-name")?.value.trim();
    const desig = document.getElementById("auth-designation")?.value.trim();
    const badge = document.getElementById("auth-badge-number")?.value.trim();
    const email = document.getElementById("auth-official-email")?.value.trim() || null;
    const just = document.getElementById("auth-justification")?.value.trim();

    try {
        const res = await fetch(`${API_BASE}/auth/authority-application`, {
            method: "POST",
            headers: authHeaders(),
            body: JSON.stringify({
                organization_name: org,
                designation: desig,
                official_id_badge_number: badge,
                official_email: email,
                purpose_justification: just
            })
        });

        if (res.ok) {
            closeModal("modal-authority-application");
            showToast("Authority application submitted! Status: AUTHORITY_PENDING", "success");
            checkAuthSession();
        } else {
            const err = await res.json();
            showToast(err.detail || "Application submission failed.", "error");
        }
    } catch (err) {
        showToast("Network error submitting application.", "error");
    }
}

// ==================== ADMIN AUTHORITY MANAGEMENT ====================
async function loadAdminAuthorityApplications() {
    if (!currentUser || currentUser.role !== "ADMIN") return;

    const listEl = document.getElementById("admin-authority-list");
    const filterEl = document.getElementById("filter-authority-status");
    const statusVal = filterEl ? filterEl.value : "";
    const badgeEl = document.getElementById("badge-pending-authorities");

    try {
        const url = statusVal ? `${API_BASE}/admin/authority-applications?status=${statusVal}` : `${API_BASE}/admin/authority-applications`;
        const res = await fetch(url, { headers: authHeaders() });
        if (res.ok) {
            const apps = await res.json();
            
            // Update pending badge
            const pendingCount = apps.filter(a => a.status === "PENDING").length;
            if (badgeEl) {
                badgeEl.textContent = pendingCount;
                badgeEl.classList.toggle("hidden", pendingCount === 0);
            }

            renderAdminAuthorityApplications(apps);
        } else {
            if (listEl) listEl.innerHTML = `<div class="p-8 text-center text-red-500 text-xs">Failed to load applications.</div>`;
        }
    } catch (err) {
        if (listEl) listEl.innerHTML = `<div class="p-8 text-center text-red-500 text-xs">Network error connecting to admin service.</div>`;
    }
}

function renderAdminAuthorityApplications(apps) {
    const listEl = document.getElementById("admin-authority-list");
    if (!listEl) return;

    if (!apps || apps.length === 0) {
        listEl.innerHTML = `<div class="p-12 text-center text-slate-400 text-xs bg-white rounded-3xl border border-slate-200">No authority applications found matching this status filter.</div>`;
        return;
    }

    listEl.innerHTML = apps.map(app => {
        const stBadge = app.status === "APPROVED" ? "bg-emerald-100 text-emerald-800 border-emerald-200" :
                        app.status === "REJECTED" ? "bg-red-100 text-red-800 border-red-200" :
                        "bg-amber-100 text-amber-800 border-amber-200 animate-pulse";
        
        return `
            <div class="bg-white rounded-3xl p-6 border border-slate-200 shadow-sm space-y-4">
                <div class="flex flex-col sm:flex-row sm:items-center justify-between gap-2 border-b border-slate-100 pb-3">
                    <div class="flex items-center gap-3">
                        <div class="w-10 h-10 rounded-2xl bg-purple-50 text-purple-700 flex items-center justify-center font-bold text-lg">
                            🛡️
                        </div>
                        <div>
                            <h3 class="text-sm font-extrabold text-slate-950">${app.organization_name}</h3>
                            <div class="flex items-center gap-2 text-xs text-slate-500">
                                <span>${app.designation}</span>
                                <span>•</span>
                                <span class="font-mono font-bold text-slate-700">Badge #${app.official_id_badge_number}</span>
                            </div>
                        </div>
                    </div>
                    <span class="px-2.5 py-1 rounded-xl text-xs font-black uppercase border ${stBadge}">
                        ${app.status}
                    </span>
                </div>

                <div class="grid grid-cols-1 md:grid-cols-2 gap-4 text-xs">
                    <div class="p-3.5 bg-slate-50 rounded-2xl border border-slate-100 space-y-1">
                        <span class="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">Applicant Identity</span>
                        <div class="font-bold text-slate-900">${app.applicant ? app.applicant.name : `User #${app.user_id}`}</div>
                        <div class="text-slate-500">${app.applicant ? app.applicant.email : ''}</div>
                        <div class="text-emerald-700 font-mono font-semibold">${app.applicant && app.applicant.phone_number ? app.applicant.phone_number : 'No Phone'}</div>
                    </div>

                    <div class="p-3.5 bg-slate-50 rounded-2xl border border-slate-100 space-y-1">
                        <span class="text-[10px] font-bold text-slate-400 uppercase tracking-wider block">Official Details</span>
                        <div class="text-slate-700"><strong>Official Email:</strong> ${app.official_email || 'Not provided'}</div>
                        <div class="text-slate-500 text-[11px]">Submitted on ${new Date(app.created_at).toLocaleString()}</div>
                    </div>
                </div>

                <div class="p-3.5 bg-slate-50/80 rounded-2xl border border-slate-100 text-xs">
                    <span class="text-[10px] font-bold text-slate-400 uppercase tracking-wider block mb-1">Operational Justification</span>
                    <p class="text-slate-700 italic">"${app.purpose_justification}"</p>
                </div>

                ${app.status === 'PENDING' ? `
                    <div class="flex flex-col sm:flex-row items-stretch sm:items-center justify-end gap-2 pt-2 border-t border-slate-100">
                        <input type="text" id="admin-notes-${app.id}" placeholder="Admin review notes (optional)..."
                            class="border border-slate-200 rounded-xl px-3 py-2 text-xs flex-1 max-w-sm">
                        <button onclick="reviewAuthorityApplication(${app.id}, 'REJECT')"
                            class="px-4 py-2 bg-slate-100 hover:bg-red-50 text-slate-700 hover:text-red-700 border border-slate-200 rounded-xl text-xs font-bold transition">
                            ✕ Reject
                        </button>
                        <button onclick="reviewAuthorityApplication(${app.id}, 'APPROVE')"
                            class="px-5 py-2 bg-gradient-to-r from-purple-600 to-indigo-600 hover:from-purple-700 hover:to-indigo-700 text-white rounded-xl text-xs font-extrabold shadow-md shadow-purple-500/20 transition flex items-center gap-1.5 justify-center">
                            <span>✓ Approve as Verified Authority</span>
                        </button>
                    </div>
                ` : `
                    <div class="text-[11px] text-slate-400 italic pt-1">
                        Reviewed on ${app.reviewed_at ? new Date(app.reviewed_at).toLocaleString() : 'N/A'} ${app.review_notes ? `— Notes: "${app.review_notes}"` : ''}
                    </div>
                `}
            </div>
        `;
    }).join('');
}

async function reviewAuthorityApplication(appId, decision) {
    if (!currentUser || currentUser.role !== "ADMIN") return;

    const notesInput = document.getElementById(`admin-notes-${appId}`);
    const notes = notesInput ? notesInput.value.trim() : null;

    try {
        const res = await fetch(`${API_BASE}/admin/authority-applications/${appId}/review`, {
            method: "POST",
            headers: authHeaders(),
            body: JSON.stringify({
                decision: decision,
                review_notes: notes
            })
        });

        if (res.ok) {
            showToast(`Application #${appId} successfully ${decision.toLowerCase()}d!`, "success");
            loadAdminAuthorityApplications();
        } else {
            const err = await res.json();
            showToast(err.detail || "Review action failed.", "error");
        }
    } catch (err) {
        showToast("Network error reviewing application.", "error");
    }
}

async function loginWithGoogle() {
    try {
        const res = await fetch(`${API_BASE}/auth/google/login`);
        const data = await res.json();
        if (data && data.client_id_configured === false) {
            showToast("Google Client ID not configured in backend/.env. Using Quick Dev Login.", "info");
            return;
        }
        window.location.href = `${API_BASE}/auth/google/login`;
    } catch (err) {
        showToast("Google Auth initiation error.", "error");
    }
}

async function loginDevUser(email, name, role) {
    try {
        const res = await fetch(`${API_BASE}/auth/dev/login`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ email, name })
        });
        if (res.ok) {
            const data = await res.json();
            authToken = data.access_token;
            currentUser = data.user;
            localStorage.setItem("access_token", authToken);
            localStorage.setItem("disasterhub_auth_token", authToken);
            updateAuthUI(currentUser);
            showToast(`Signed in as ${currentUser.name} (${currentUser.role})`, "success");
        } else {
            showToast("Authentication failed.", "error");
        }
    } catch (err) {
        showToast("Error connecting to auth service.", "error");
    }
}

function logout() {
    authToken = null;
    currentUser = null;
    localStorage.removeItem("selected_role");
    localStorage.removeItem("auth_user");
    window.location.replace("login.html");
}

async function updateReportStatus(reportId, newStatus) {
    if (!currentUser || !["AUTHORITY_VERIFIED", "ADMIN"].includes(currentUser.role)) {
        showToast("Authority access required to change report status.", "error");
        return;
    }
    try {
        const res = await fetch(`${API_BASE}/reports/${reportId}/status`, {
            method: "PATCH",
            headers: authHeaders(),
            body: JSON.stringify({ status: newStatus })
        });
        if (res.ok) {
            showToast(`Report #${reportId} status updated to "${newStatus}"`, "success");
            loadAuthorityDashboard();
            loadOverview();
            if (activeTab === "disasters") loadDisasters();
        } else {
            const err = await res.json();
            showToast(err.detail || "Failed to update report status", "error");
        }
    } catch (e) {
        showToast("Error connecting to server", "error");
    }
}

// ==================== MISSING PERSONS REGISTRY (CATEGORY 5) ====================
let currentMissingPersons = [];

async function loadMissingPersons() {
    const statusFilter = document.getElementById("filter-missing-status")?.value || "";
    const genderFilter = document.getElementById("filter-missing-gender")?.value || "";
    const query = document.getElementById("search-missing-query")?.value || "";

    let url = `${API_BASE}/missing-persons/?`;
    if (statusFilter) url += `status=${encodeURIComponent(statusFilter)}&`;
    if (genderFilter) url += `gender=${encodeURIComponent(genderFilter)}&`;
    if (query) url += `q=${encodeURIComponent(query)}&`;

    try {
        const res = await fetch(url);
        currentMissingPersons = await res.json();
        renderMissingPersonsGrid(currentMissingPersons);
    } catch (err) {
        console.warn("Error loading missing persons:", err);
    }
}

function filterMissingPersons() {
    loadMissingPersons();
}

function resetMissingPersonFilters() {
    const s = document.getElementById("filter-missing-status");
    const g = document.getElementById("filter-missing-gender");
    const q = document.getElementById("search-missing-query");
    if (s) s.value = "MISSING";
    if (g) g.value = "";
    if (q) q.value = "";
    loadMissingPersons();
}

function renderMissingPersonsGrid(records) {
    const container = document.getElementById("missing-persons-grid");
    if (!container) return;

    if (!records || records.length === 0) {
        container.innerHTML = `
            <div class="col-span-full p-12 text-center text-slate-400 space-y-2">
                <div class="text-3xl">🔍</div>
                <div class="font-extrabold text-slate-700 text-sm">No Missing Person Cases Found</div>
                <p class="text-slate-400 text-xs">No records match your active search and filter criteria.</p>
            </div>
        `;
        return;
    }

    container.innerHTML = records.map(mp => {
        const statusClass = mp.status === "MISSING" ? "bg-amber-100 text-amber-800 border-amber-200"
                          : mp.status === "FOUND" ? "bg-emerald-100 text-emerald-800 border-emerald-200"
                          : mp.status === "REUNITED" ? "bg-blue-100 text-blue-800 border-blue-200"
                          : "bg-slate-100 text-slate-700 border-slate-200";

        const photoHtml = mp.photo_url 
            ? `<img src="${mp.photo_url}" alt="${mp.full_name}" class="w-full h-48 object-cover rounded-2xl mb-4 border border-slate-100">`
            : `<div class="w-full h-48 bg-slate-100 rounded-2xl mb-4 flex items-center justify-center text-4xl text-slate-300">👤</div>`;

        const isAuthority = currentUser && ["AUTHORITY_VERIFIED", "ADMIN"].includes(currentUser.role);
        const authorityControlHtml = isAuthority ? `
            <div class="pt-2 border-t border-slate-100 flex items-center justify-between gap-2">
                <span class="text-[10px] font-extrabold uppercase text-purple-700 font-mono">🛡️ Authority Action:</span>
                <select onchange="promoteMissingPersonStatus(${mp.id}, this.value)" class="text-xs border border-purple-200 rounded-xl px-2 py-1 bg-purple-50 font-extrabold text-purple-900 focus:outline-none">
                    <option value="">Status Transition...</option>
                    <option value="MISSING" ${mp.status === "MISSING" ? "disabled" : ""}>Mark MISSING</option>
                    <option value="FOUND" ${mp.status === "FOUND" ? "disabled" : ""}>Mark FOUND</option>
                    <option value="REUNITED" ${mp.status === "REUNITED" ? "disabled" : ""}>Mark REUNITED</option>
                    <option value="CLOSED" ${mp.status === "CLOSED" ? "disabled" : ""}>Close Case</option>
                </select>
            </div>
        ` : '';

        return `
            <div class="command-card p-6 space-y-3 flex flex-col justify-between">
                <div>
                    ${photoHtml}
                    <div class="flex items-center justify-between gap-2">
                        <h3 class="font-extrabold text-slate-950 text-base">${mp.full_name}</h3>
                        <span class="text-[10px] px-2.5 py-0.5 rounded-full font-mono font-extrabold border ${statusClass}">
                            ${mp.status}
                        </span>
                    </div>

                    <div class="flex items-center gap-3 text-xs text-slate-500 font-medium mt-1">
                        <span>Age: <strong>${mp.age}</strong></span> &bull;
                        <span>Gender: <strong>${mp.gender}</strong></span> &bull;
                        <span>Case #${mp.id}</span>
                    </div>

                    <div class="text-xs text-slate-700 pt-2 space-y-1">
                        <p><strong>📍 Last Seen:</strong> ${mp.last_seen_location}</p>
                        <p><strong>📅 Date/Time:</strong> ${new Date(mp.last_seen_date).toLocaleString("en-IN", {timeZone:"Asia/Kolkata"})}</p>
                        ${mp.description_clothing ? `<p class="text-slate-600"><strong>👔 Clothing/Marks:</strong> ${mp.description_clothing}</p>` : ''}
                        ${mp.medical_conditions ? `<p class="text-red-700 bg-red-50 p-2 rounded-xl border border-red-100"><strong>💊 Medical:</strong> ${mp.medical_conditions}</p>` : ''}
                    </div>

                    ${authorityControlHtml}
                </div>

                <div class="pt-3 border-t border-slate-100 flex flex-col sm:flex-row items-stretch sm:items-center justify-between gap-2 text-xs">
                    <span class="text-slate-400">Reported by: ${mp.reporter_name || 'Citizen'}</span>
                    <div class="flex items-center gap-1.5 flex-wrap">
                        <button onclick="openAuditLogModal(${mp.id}, '${mp.full_name.replace(/'/g, "\\'")}')" class="px-2 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl font-bold transition text-[11px]">
                            📜 Audit
                        </button>
                        <button onclick="openViewSuggestionsModal(${mp.id}, '${mp.full_name.replace(/'/g, "\\'")}')" class="px-2 py-1.5 bg-slate-100 hover:bg-slate-200 text-slate-700 rounded-xl font-bold transition text-[11px]">
                            💬 Sightings
                        </button>
                        <button onclick="openFoundSuggestionModal(${mp.id}, '${mp.full_name.replace(/'/g, "\\'")}')" class="px-2.5 py-1.5 bg-amber-600 hover:bg-amber-700 text-white rounded-xl font-bold transition text-[11px]">
                            🙋 Sighting
                        </button>
                        <a href="tel:${mp.contact_phone}" class="px-2 py-1.5 bg-emerald-600 hover:bg-emerald-700 text-white rounded-xl font-bold flex items-center gap-1 transition text-[11px]">
                            📞 Call
                        </a>
                    </div>
                </div>
            </div>
        `;
    }).join("");
}

function openRegisterMissingPersonModal() {
    const phoneInput = document.getElementById("missing-contact-phone");
    if (phoneInput && currentUser && currentUser.phone_number) {
        phoneInput.value = currentUser.phone_number.replace(/^\+91/, "");
    }
    openModal("modal-register-missing");
}

async function handleRegisterMissingPerson(e) {
    e.preventDefault();

    const photoInput = document.getElementById("missing-photo-file");
    let uploadedPhotoUrl = null;

    if (photoInput && photoInput.files && photoInput.files.length > 0) {
        const file = photoInput.files[0];
        const formData = new FormData();
        formData.append("file", file);

        try {
            showToast("Uploading photo...", "info");
            const uploadRes = await fetch(`${API_BASE}/missing-persons/upload-photo`, {
                method: "POST",
                headers: authHeaders({ skipContentType: true }),
                body: formData
            });

            if (uploadRes.ok) {
                const data = await uploadRes.json();
                uploadedPhotoUrl = data.photo_url;
            } else {
                const errData = await uploadRes.json();
                showToast(`Photo upload failed: ${errData.detail || "Error"}`, "warning");
            }
        } catch (err) {
            console.warn("Photo upload error:", err);
        }
    }

    const payload = {
        full_name: document.getElementById("missing-full-name").value.trim(),
        age: parseInt(document.getElementById("missing-age").value, 10),
        gender: document.getElementById("missing-gender").value,
        contact_phone: document.getElementById("missing-contact-phone").value.trim(),
        last_seen_location: document.getElementById("missing-location").value.trim(),
        last_seen_date: new Date(document.getElementById("missing-date").value).toISOString(),
        photo_url: uploadedPhotoUrl,
        description_clothing: document.getElementById("missing-clothing").value.trim() || null,
        medical_conditions: document.getElementById("missing-medical").value.trim() || null
    };

    try {
        const res = await fetch(`${API_BASE}/missing-persons/`, {
            method: "POST",
            headers: authHeaders(),
            body: JSON.stringify(payload)
        });

        if (res.ok) {
            const data = await res.json();
            showToast(`Missing person case #${data.id} registered successfully!`, "success");
            closeModal("modal-register-missing");
            document.getElementById("form-register-missing").reset();
            loadMissingPersons();
        } else {
            const err = await res.json();
            showToast(err.detail || "Registration failed.", "error");
        }
    } catch (err) {
        showToast("Error registering missing person case.", "error");
    }
}

// ==================== FOUND-PERSON SUGGESTION SYSTEM (CATEGORY 6) ====================
function openFoundSuggestionModal(mpId, name) {
    document.getElementById("found-target-mp-id").value = mpId;
    document.getElementById("found-target-person-banner").textContent = `Target Case #${mpId}: ${name}`;
    
    const phoneInput = document.getElementById("found-contact-phone");
    if (phoneInput && currentUser && currentUser.phone_number) {
        phoneInput.value = currentUser.phone_number.replace(/^\+91/, "");
    }
    openModal("modal-found-suggestion");
}

async function handleFoundSuggestionSubmit(e) {
    e.preventDefault();

    const mpId = document.getElementById("found-target-mp-id").value;
    const photoInput = document.getElementById("found-photo-file");
    let uploadedPhotoUrl = null;

    if (photoInput && photoInput.files && photoInput.files.length > 0) {
        const file = photoInput.files[0];
        const formData = new FormData();
        formData.append("file", file);

        try {
            showToast("Uploading evidence photo...", "info");
            const uploadRes = await fetch(`${API_BASE}/found-suggestions/upload-photo`, {
                method: "POST",
                headers: authHeaders({ skipContentType: true }),
                body: formData
            });

            if (uploadRes.ok) {
                const data = await uploadRes.json();
                uploadedPhotoUrl = data.photo_url;
            } else {
                const errData = await uploadRes.json();
                showToast(`Photo upload failed: ${errData.detail || "Error"}`, "warning");
            }
        } catch (err) {
            console.warn("Evidence photo upload error:", err);
        }
    }

    const payload = {
        found_location: document.getElementById("found-location").value.trim(),
        found_date: new Date(document.getElementById("found-date").value).toISOString(),
        contact_phone: document.getElementById("found-contact-phone").value.trim(),
        photo_url: uploadedPhotoUrl,
        notes: document.getElementById("found-notes").value.trim()
    };

    try {
        const res = await fetch(`${API_BASE}/missing-persons/${mpId}/suggestions`, {
            method: "POST",
            headers: authHeaders(),
            body: JSON.stringify(payload)
        });

        if (res.ok) {
            showToast(`Sighting report for Case #${mpId} submitted successfully for verification!`, "success");
            closeModal("modal-found-suggestion");
            document.getElementById("form-found-suggestion").reset();
            loadMissingPersons();
        } else {
            const err = await res.json();
            showToast(err.detail || "Submission failed.", "error");
        }
    } catch (err) {
        showToast("Error submitting found suggestion.", "error");
    }
}

async function openViewSuggestionsModal(mpId, name) {
    document.getElementById("suggestions-modal-title").textContent = `Sighting Reports for Case #${mpId}: ${name}`;
    const container = document.getElementById("suggestions-list-container");
    container.innerHTML = `<div class="p-8 text-center text-slate-400 text-xs">Loading sighting reports...</div>`;
    openModal("modal-view-suggestions");

    try {
        const res = await fetch(`${API_BASE}/missing-persons/${mpId}/suggestions`);
        const suggestions = await res.json();

        if (!suggestions || suggestions.length === 0) {
            container.innerHTML = `
                <div class="p-8 text-center text-slate-400 space-y-2">
                    <div class="text-3xl">📭</div>
                    <div class="font-extrabold text-slate-700 text-sm">No Sighting Reports Yet</div>
                    <p class="text-xs text-slate-400">Be the first to submit a sighting report if you have seen this person.</p>
                </div>
            `;
            return;
        }

        container.innerHTML = suggestions.map(s => {
            const photoHtml = s.photo_url 
                ? `<img src="${s.photo_url}" class="w-full h-36 object-cover rounded-xl border border-slate-100 mb-2">` 
                : '';

            return `
                <div class="p-4 bg-slate-50 rounded-2xl border border-slate-200 space-y-2 text-xs">
                    <div class="flex items-center justify-between">
                        <span class="font-extrabold text-slate-900">📍 ${s.found_location}</span>
                        <span class="text-[10px] px-2 py-0.5 rounded bg-amber-100 text-amber-800 font-bold font-mono">STATUS: ${s.status}</span>
                    </div>
                    ${photoHtml}
                    <p class="text-slate-700 leading-relaxed bg-white p-3 rounded-xl border border-slate-100">${s.notes}</p>
                    <div class="flex items-center justify-between text-[11px] text-slate-500 pt-1">
                        <span>Spotted on ${new Date(s.found_date).toLocaleString("en-IN", {timeZone:"Asia/Kolkata"})} by <strong>${s.submitter_name || 'Citizen'}</strong></span>
                        <a href="tel:${s.contact_phone}" class="font-bold text-emerald-700 hover:underline">📞 ${s.contact_phone}</a>
                    </div>
                </div>
            `;
        }).join("");
    } catch (err) {
        container.innerHTML = `<div class="p-8 text-center text-red-500 text-xs">Error loading sighting reports.</div>`;
    }
}

// ==================== AUTHORITY MISSING-PERSON MANAGEMENT & AUDIT TRAIL (CATEGORY 7) ====================
async function promoteMissingPersonStatus(mpId, newStatus) {
    if (!newStatus) return;
    if (!currentUser || !["AUTHORITY_VERIFIED", "ADMIN"].includes(currentUser.role)) {
        showToast("Forbidden: Verified Authority credentials required to promote case status.", "error");
        return;
    }

    try {
        showToast(`Promoting case #${mpId} status to ${newStatus}...`, "info");
        const res = await fetch(`${API_BASE}/missing-persons/${mpId}/status`, {
            method: "PATCH",
            headers: authHeaders(),
            body: JSON.stringify({
                status: newStatus,
                notes: `Official status promotion by ${currentUser.name} (${currentUser.role})`
            })
        });

        if (res.ok) {
            showToast(`Case #${mpId} updated to ${newStatus}! Audit log entry created.`, "success");
            loadMissingPersons();
        } else {
            const err = await res.json();
            showToast(`Failed: ${err.detail || "Status update failed"}`, "error");
        }
    } catch (err) {
        showToast("Error updating case status.", "error");
    }
}

async function openAuditLogModal(mpId, name) {
    document.getElementById("audit-modal-title").textContent = `Audit Log Trail for Case #${mpId}: ${name}`;
    const container = document.getElementById("audit-logs-list-container");
    container.innerHTML = `<div class="p-8 text-center text-slate-400 text-xs">Loading audit trail...</div>`;
    openModal("modal-view-audit-logs");

    try {
        const res = await fetch(`${API_BASE}/missing-persons/${mpId}/audit-logs`);
        const logs = await res.json();

        if (!logs || logs.length === 0) {
            container.innerHTML = `
                <div class="p-8 text-center text-slate-400 space-y-2">
                    <div class="text-3xl">📜</div>
                    <div class="font-extrabold text-slate-700 text-sm">No Audit Entries Yet</div>
                    <p class="text-xs text-slate-400">Case status has not been officially altered since initial registration.</p>
                </div>
            `;
            return;
        }

        container.innerHTML = logs.map(log => `
            <div class="p-4 bg-slate-50 rounded-2xl border border-slate-200 space-y-2 text-xs">
                <div class="flex items-center justify-between">
                    <div class="flex items-center gap-2">
                        <span class="font-bold text-slate-500 font-mono">${log.previous_status}</span>
                        <span class="text-slate-400">➔</span>
                        <span class="font-extrabold text-purple-700 font-mono">${log.new_status}</span>
                    </div>
                    <span class="text-[10px] text-slate-400">${new Date(log.created_at).toLocaleString("en-IN", {timeZone:"Asia/Kolkata"})}</span>
                </div>
                <p class="text-slate-700 bg-white p-2.5 rounded-xl border border-slate-100 font-medium">${log.notes || 'Status changed'}</p>
                <div class="text-[11px] text-slate-500 pt-0.5">
                    Authorized Officer: <strong>${log.performed_by_name || 'Admin'}</strong> (${log.performed_by_role || 'ADMIN'})
                </div>
            </div>
        `).join("");
    } catch (err) {
        container.innerHTML = `<div class="p-8 text-center text-red-500 text-xs">Error loading audit logs.</div>`;
    }
}

// ==================== USER DASHBOARD & PROFILE (CATEGORY 11) ====================
function switchUserDashboardSubtab(subtab) {
    const tabs = ["reports", "missing", "sightings"];
    tabs.forEach(t => {
        const btn = document.getElementById(`btn-subtab-${t}`);
        const panel = document.getElementById(`user-dashboard-subtab-${t}`);
        if (t === subtab) {
            if (btn) btn.className = "px-3.5 py-1.5 rounded-xl font-bold text-xs bg-slate-900 text-white shadow-sm transition";
            if (panel) panel.classList.remove("hidden");
        } else {
            if (btn) btn.className = "px-3.5 py-1.5 rounded-xl font-bold text-xs bg-slate-100 text-slate-600 hover:bg-slate-200 transition";
            if (panel) panel.classList.add("hidden");
        }
    });
}

async function loadUserDashboard() {
    if (!currentUser || !authToken) {
        showToast("Please sign in to access your personal dashboard.", "warning");
        window.location.href = "login.html";
        return;
    }

    // 1. Populate Profile Card
    document.getElementById("dashboard-name").textContent = currentUser.name || "Citizen";
    document.getElementById("dashboard-email").textContent = currentUser.email || "--";
    document.getElementById("dashboard-phone").textContent = currentUser.phone_number || "Not verified";
    document.getElementById("dashboard-role-badge").textContent = currentUser.role;
    if (currentUser.picture) {
        document.getElementById("dashboard-avatar").src = currentUser.picture;
    }
    if (currentUser.created_at) {
        document.getElementById("dashboard-member-since").textContent = new Date(currentUser.created_at).toLocaleDateString("en-IN", {
            day: "numeric", month: "short", year: "numeric"
        });
    }

    // 2. Render Authority Status Card
    const authCard = document.getElementById("dashboard-authority-content");
    if (currentUser.role === "ADMIN") {
        authCard.innerHTML = `
            <div class="space-y-3">
                <div class="flex items-center gap-3">
                    <span class="p-2.5 bg-blue-100 text-blue-700 rounded-2xl text-xl">🛡️</span>
                    <div>
                        <div class="text-xs font-black uppercase text-blue-700 font-mono tracking-wider">Operational Rank</div>
                        <h3 class="text-base font-extrabold text-slate-950">Disaster Command System Administrator</h3>
                    </div>
                </div>
                <p class="text-xs text-slate-600 leading-relaxed">Full system governance active. You have permissions to review authority applications, verify incident reports, broadcast alerts, and manage all relief resources.</p>
                <div class="pt-2 flex items-center gap-2">
                    <button onclick="switchTab('admin-authorities')" class="px-3.5 py-2 bg-blue-600 hover:bg-blue-700 text-white rounded-xl text-xs font-bold shadow-sm transition">
                        Review Authority Applications &rarr;
                    </button>
                    <button onclick="switchTab('verification')" class="px-3.5 py-2 bg-purple-600 hover:bg-purple-700 text-white rounded-xl text-xs font-bold shadow-sm transition">
                        AI Verification Queue &rarr;
                    </button>
                </div>
            </div>
        `;
    } else if (currentUser.role === "AUTHORITY_VERIFIED") {
        const appInfo = currentUser.authority_application || {};
        authCard.innerHTML = `
            <div class="space-y-3">
                <div class="flex items-center gap-3">
                    <span class="p-2.5 bg-emerald-100 text-emerald-700 rounded-2xl text-xl">✅</span>
                    <div>
                        <div class="text-xs font-black uppercase text-emerald-700 font-mono tracking-wider">Verified Emergency Authority</div>
                        <h3 class="text-base font-extrabold text-slate-950">${appInfo.organization_name || 'Emergency Responder'}</h3>
                    </div>
                </div>
                <div class="p-3 bg-emerald-50 rounded-xl border border-emerald-100 text-xs space-y-1">
                    <p><strong>Designation:</strong> ${appInfo.designation || 'Operational Commander'}</p>
                    <p><strong>Official Badge / ID:</strong> <span class="font-mono">${appInfo.official_id_badge_number || 'VERIFIED'}</span></p>
                </div>
                <p class="text-xs text-slate-600">You have verified command authorization to manage missing person cases, confirm incident reports, and broadcast early warnings.</p>
            </div>
        `;
    } else if (currentUser.role === "AUTHORITY_PENDING") {
        const appInfo = currentUser.authority_application || {};
        authCard.innerHTML = `
            <div class="space-y-3">
                <div class="flex items-center gap-3">
                    <span class="p-2.5 bg-amber-100 text-amber-700 rounded-2xl text-xl">⏳</span>
                    <div>
                        <div class="text-xs font-black uppercase text-amber-700 font-mono tracking-wider">Application Under Review</div>
                        <h3 class="text-base font-extrabold text-slate-950">${appInfo.organization_name || 'Authority Verification in Progress'}</h3>
                    </div>
                </div>
                <p class="text-xs text-slate-600 leading-relaxed">Your authority verification application is currently queued for Disaster Command Administrator review. You will be notified upon decision.</p>
                <div class="p-3 bg-amber-50 rounded-xl border border-amber-100 text-xs text-amber-900 font-mono space-y-1">
                    <div>Designation: <strong>${appInfo.designation || '--'}</strong></div>
                    <div>Badge Number: <strong>${appInfo.official_id_badge_number || '--'}</strong></div>
                </div>
            </div>
        `;
    } else {
        // Normal Citizen USER
        authCard.innerHTML = `
            <div class="space-y-3">
                <div class="flex items-center gap-3">
                    <span class="p-2.5 bg-purple-100 text-purple-700 rounded-2xl text-xl">🛡️</span>
                    <div>
                        <div class="text-xs font-black uppercase text-purple-700 font-mono tracking-wider">Emergency Services Application</div>
                        <h3 class="text-base font-extrabold text-slate-950">Are you an Emergency Responder?</h3>
                    </div>
                </div>
                <p class="text-xs text-slate-600 leading-relaxed">NDRF, State Disaster Response Forces (SDRF), Police, Fire & Rescue, and Medical Officers can apply for verified authority operational access to lead rescue operations.</p>
                <button onclick="openAuthorityApplicationModal()" class="px-4 py-2.5 bg-purple-600 hover:bg-purple-700 text-white rounded-xl font-bold text-xs shadow-md shadow-purple-500/20 transition flex items-center gap-2">
                    <span>🛡️</span> Apply for Official Authority Access &rarr;
                </button>
            </div>
        `;
    }

    // 3. Fetch User's Data Feeds in Parallel
    try {
        const [reportsRes, missingRes, sightingsRes] = await Promise.all([
            fetch(`${API_BASE}/reports/my`, { headers: authHeaders() }),
            fetch(`${API_BASE}/missing-persons/my`, { headers: authHeaders() }),
            fetch(`${API_BASE}/found-suggestions/my`, { headers: authHeaders() })
        ]);

        const reports = reportsRes.ok ? await reportsRes.json() : [];
        const missingCases = missingRes.ok ? await missingRes.json() : [];
        const sightings = sightingsRes.ok ? await sightingsRes.json() : [];

        // Update KPI counters
        document.getElementById("kpi-my-reports").textContent = reports.length;
        document.getElementById("kpi-my-missing").textContent = missingCases.length;
        document.getElementById("kpi-my-sightings").textContent = sightings.length;

        document.getElementById("count-subtab-reports").textContent = reports.length;
        document.getElementById("count-subtab-missing").textContent = missingCases.length;
        document.getElementById("count-subtab-sightings").textContent = sightings.length;

        // Render Subtab A: Incident Reports
        const reportsContainer = document.getElementById("user-dashboard-subtab-reports");
        if (reports.length === 0) {
            reportsContainer.innerHTML = `
                <div class="p-12 text-center text-slate-400 space-y-2">
                    <div class="text-3xl">📭</div>
                    <div class="font-extrabold text-slate-700 text-sm">No Incident Reports Submitted Yet</div>
                    <p class="text-xs text-slate-400">When you submit emergency reports via the Smart Reporting Center, they will be tracked here.</p>
                </div>
            `;
        } else {
            reportsContainer.innerHTML = reports.map(r => `
                <div class="p-4 bg-slate-50 rounded-2xl border border-slate-200 flex flex-col md:flex-row md:items-center justify-between gap-4 text-xs">
                    <div class="space-y-1">
                        <div class="flex items-center gap-2">
                            <span class="font-extrabold text-slate-950 text-sm">${r.type}</span>
                            <span class="px-2 py-0.5 rounded-full text-[10px] font-mono font-extrabold bg-blue-100 text-blue-800">${r.status}</span>
                        </div>
                        <p class="text-slate-600">📍 ${r.location}</p>
                        <p class="text-slate-500">${r.description || 'No additional details.'}</p>
                        <div class="text-slate-400 text-[11px] pt-1">
                            👥 ${r.people_affected_count} affected &bull; 🕒 ${new Date(r.created_at).toLocaleString("en-IN", {timeZone:"Asia/Kolkata"})}
                        </div>
                    </div>
                    ${r.image_url ? `<img src="${r.image_url.startsWith('http') ? r.image_url : API_BASE + r.image_url}" alt="Report photo" class="w-20 h-20 rounded-xl object-cover border border-slate-200 shrink-0 cursor-pointer hover:opacity-90 transition" onclick="window.open('${r.image_url.startsWith('http') ? r.image_url : API_BASE + r.image_url}', '_blank')">` : ''}
                </div>
            `).join("");
        }

        // Render Subtab B: Missing Persons Cases
        const missingContainer = document.getElementById("user-dashboard-subtab-missing");
        if (missingCases.length === 0) {
            missingContainer.innerHTML = `
                <div class="p-12 text-center text-slate-400 space-y-2">
                    <div class="text-3xl">👥</div>
                    <div class="font-extrabold text-slate-700 text-sm">No Missing Person Cases Registered</div>
                    <p class="text-xs text-slate-400">Register missing family members or community individuals to facilitate tracking and reunions.</p>
                </div>
            `;
        } else {
            missingContainer.innerHTML = missingCases.map(mp => {
                const statusClass = mp.status === "MISSING" ? "bg-amber-100 text-amber-800"
                                  : mp.status === "FOUND" ? "bg-emerald-100 text-emerald-800"
                                  : mp.status === "REUNITED" ? "bg-blue-100 text-blue-800" : "bg-slate-100 text-slate-700";
                return `
                    <div class="p-4 bg-slate-50 rounded-2xl border border-slate-200 flex flex-col md:flex-row md:items-center justify-between gap-4 text-xs">
                        <div class="space-y-1">
                            <div class="flex items-center gap-2">
                                <span class="font-extrabold text-slate-950 text-sm">${mp.full_name}</span>
                                <span class="px-2 py-0.5 rounded-full text-[10px] font-mono font-extrabold ${statusClass}">${mp.status}</span>
                            </div>
                            <p class="text-slate-600">📍 Last Seen: ${mp.last_seen_location}</p>
                            <p class="text-slate-500">Age: ${mp.age} &bull; Gender: ${mp.gender}</p>
                            <div class="text-slate-400 text-[11px] pt-1">
                                🗓️ Registered: ${new Date(mp.created_at).toLocaleString("en-IN", {timeZone:"Asia/Kolkata"})}
                            </div>
                        </div>
                        <div class="flex items-center gap-2">
                            <button onclick="openViewSuggestionsModal(${mp.id}, '${mp.full_name.replace(/'/g, "\\'")}')" class="px-3 py-1.5 bg-slate-200 hover:bg-slate-300 text-slate-800 rounded-xl font-bold transition text-[11px]">
                                💬 Sighting Reports
                            </button>
                            <button onclick="openAuditLogModal(${mp.id}, '${mp.full_name.replace(/'/g, "\\'")}')" class="px-3 py-1.5 bg-blue-100 hover:bg-blue-200 text-blue-800 rounded-xl font-bold transition text-[11px]">
                                📜 Case Audit Log
                            </button>
                        </div>
                    </div>
                `;
            }).join("");
        }

        // Render Subtab C: Sighting Suggestions
        const sightingsContainer = document.getElementById("user-dashboard-subtab-sightings");
        if (sightings.length === 0) {
            sightingsContainer.innerHTML = `
                <div class="p-12 text-center text-slate-400 space-y-2">
                    <div class="text-3xl">🙋</div>
                    <div class="font-extrabold text-slate-700 text-sm">No Sighting Reports Submitted</div>
                    <p class="text-xs text-slate-400">When you spot a missing person and report a sighting, your submitted reports will appear here.</p>
                </div>
            `;
        } else {
            sightingsContainer.innerHTML = sightings.map(s => `
                <div class="p-4 bg-slate-50 rounded-2xl border border-slate-200 flex flex-col md:flex-row md:items-center justify-between gap-4 text-xs">
                    <div class="space-y-1">
                        <div class="flex items-center gap-2">
                            <span class="font-extrabold text-slate-950 text-sm">Sighting for Case #${s.missing_person_id}</span>
                            <span class="px-2 py-0.5 rounded-full text-[10px] font-mono font-extrabold bg-amber-100 text-amber-800">${s.status}</span>
                        </div>
                        <p class="text-slate-600">📍 Spotted at: ${s.found_location}</p>
                        <p class="text-slate-500 bg-white p-2 rounded-xl border border-slate-100">${s.notes}</p>
                        <div class="text-slate-400 text-[11px] pt-1">
                            🗓️ Date Spotted: ${new Date(s.found_date).toLocaleString("en-IN", {timeZone:"Asia/Kolkata"})}
                        </div>
                    </div>
                    ${s.photo_url ? `<img src="${s.photo_url}" alt="Sighting photo" class="w-20 h-20 rounded-xl object-cover border border-slate-200 shrink-0">` : ''}
                </div>
            `).join("");
        }

    } catch (err) {
        console.error("Failed to load user dashboard feeds:", err);
        showToast("Error loading user dashboard feeds.", "error");
    }
}

// ==================== AUTHORITY OPERATIONS CENTER (CATEGORY 12) ====================
async function loadAuthorityDashboard() {
    const contentEl = document.getElementById("authority-dashboard-content");
    if (contentEl) contentEl.classList.remove("hidden");

    try {
        // 1. Fetch Aggregated Operational Metrics
        const res = await fetch(`${API_BASE}/authority/dashboard-metrics`, { headers: authHeaders() });
        if (!res.ok) throw new Error(`Authority metrics API error: ${res.status}`);
        const data = await res.json();

        // Update KPI Counters
        document.getElementById("auth-kpi-disasters").textContent = data.active_disasters_count;
        document.getElementById("auth-kpi-critical").textContent = `${data.critical_disasters_count} Critical`;
        document.getElementById("auth-kpi-verifications").textContent = data.pending_verification_count;
        document.getElementById("auth-kpi-missing").textContent = data.active_missing_count;
        document.getElementById("auth-kpi-sightings").textContent = `${data.found_suggestions_pending_count} Sightings`;
        document.getElementById("auth-kpi-shelter-util").textContent = `${data.shelter_utilization_percent}%`;
        document.getElementById("auth-kpi-shelter-beds").textContent = `${data.shelter_occupancy_total} / ${data.shelter_capacity_total} Beds`;
        document.getElementById("auth-kpi-resources").textContent = data.pending_resource_requests_count;

        // 2. Fetch Unverified Reports & Active Missing Persons in parallel for fast triage
        const [reportsRes, missingRes] = await Promise.all([
            fetch(`${API_BASE}/reports/`),
            fetch(`${API_BASE}/missing-persons/?status=MISSING&limit=10`)
        ]);

        const allReports = reportsRes.ok ? await reportsRes.json() : [];
        const unverified = allReports.filter(r => r.status === "Submitted" || r.status === "Under Verification");
        const missingPersons = missingRes.ok ? await missingRes.json() : [];

        // Populate Unverified Reports Feed
        const reportsCountEl = document.getElementById("auth-feed-reports-count");
        if (reportsCountEl) reportsCountEl.textContent = `${unverified.length} Pending`;

        const reportsListEl = document.getElementById("auth-unverified-reports-list");
        if (unverified.length === 0) {
            reportsListEl.innerHTML = `<div class="p-8 text-center text-slate-400 text-xs">No pending unverified citizen reports. All clear!</div>`;
        } else {
            reportsListEl.innerHTML = unverified.slice(0, 8).map(r => `
                <div class="p-4 bg-slate-50 rounded-2xl border border-slate-200 space-y-2.5 text-xs">
                    <div class="flex items-center justify-between gap-2">
                        <div class="flex items-center gap-2">
                            <span class="font-extrabold text-slate-900">${r.type}</span>
                            <span class="px-1.5 py-0.5 rounded text-[9px] font-mono font-black ${r.status === 'Verified' ? 'bg-purple-100 text-purple-800' : 'bg-red-100 text-red-800'}">${r.status || 'UNVERIFIED'}</span>
                        </div>
                        <span class="text-slate-400 text-[10px]">${new Date(r.created_at).toLocaleTimeString("en-IN", {timeZone:"Asia/Kolkata"})}</span>
                    </div>
                    <p class="text-slate-600 text-[11px]">📍 ${r.location}</p>
                    ${r.description ? `<p class="text-slate-500 text-[11px] leading-snug">${r.description}</p>` : ''}
                    ${r.image_url ? `
                        <div class="mt-1.5 rounded-xl overflow-hidden border border-slate-200 max-h-36 bg-slate-900 flex items-center justify-center cursor-pointer group relative shadow-sm" onclick="window.open('${r.image_url.startsWith('http') ? r.image_url : API_BASE + r.image_url}', '_blank')">
                            <img src="${r.image_url.startsWith('http') ? r.image_url : API_BASE + r.image_url}" alt="Report Photo" class="max-h-36 w-full object-cover group-hover:scale-105 transition duration-200" onerror="this.parentElement.style.display='none'">
                            <div class="absolute bottom-1.5 right-1.5 bg-black/75 backdrop-blur text-white text-[9px] px-2 py-0.5 rounded-md font-mono font-bold flex items-center gap-1">
                                <span>📸</span> View Full Photo
                            </div>
                        </div>
                    ` : ''}
                    ${r.reporter_name ? `
                        <div class="p-2 bg-white rounded-xl border border-slate-100 text-[11px] flex items-center justify-between">
                            <span class="text-slate-700 font-semibold">👤 ${r.reporter_name}</span>
                            ${r.reporter_phone ? `<a href="tel:${r.reporter_phone}" class="font-mono text-emerald-700 font-bold hover:underline">📞 ${r.reporter_phone}</a>` : ''}
                        </div>
                    ` : ''}
                    <div class="flex items-center justify-between gap-2 pt-1 border-t border-slate-200">
                        <span class="text-[10px] text-slate-400 font-mono">Report #${r.id}</span>
                        <div class="flex items-center gap-1">
                            <select onchange="updateReportStatus(${r.id}, this.value)" class="text-[11px] font-bold border border-slate-200 rounded-lg px-2 py-1 bg-white text-slate-700 focus:outline-none">
                                <option value="">Action...</option>
                                <option value="Verified">✓ Verify</option>
                                <option value="Under Verification">⏳ In Review</option>
                                <option value="Resolved">🟢 Resolve</option>
                                <option value="Rejected">✕ Reject</option>
                            </select>
                        </div>
                    </div>
                </div>
            `).join("");
        }

        // Populate Missing Persons Feed
        const missingCountEl = document.getElementById("auth-feed-missing-count");
        if (missingCountEl) missingCountEl.textContent = `${missingPersons.length} Active`;

        const missingListEl = document.getElementById("auth-missing-persons-list");
        if (missingPersons.length === 0) {
            missingListEl.innerHTML = `<div class="p-8 text-center text-slate-400 text-xs">No active missing persons cases in command queue.</div>`;
        } else {
            missingListEl.innerHTML = missingPersons.slice(0, 8).map(mp => `
                <div class="p-3.5 bg-slate-50 rounded-2xl border border-slate-200 flex items-center justify-between gap-3 text-xs">
                    <div class="space-y-0.5 min-w-0">
                        <div class="flex items-center gap-2">
                            <span class="font-extrabold text-slate-900 truncate">${mp.full_name}</span>
                            <span class="px-1.5 py-0.5 rounded text-[9px] font-mono font-black bg-amber-100 text-amber-800">MISSING</span>
                        </div>
                        <p class="text-slate-500 truncate text-[11px]">📍 ${mp.last_seen_location}</p>
                        <p class="text-slate-400 text-[10px]">Age ${mp.age} &bull; ${mp.gender}</p>
                    </div>
                    <div class="flex items-center gap-1.5 shrink-0">
                        <button onclick="openViewSuggestionsModal(${mp.id}, '${mp.full_name.replace(/'/g, "\\'")}')" class="px-2.5 py-1.5 bg-slate-200 hover:bg-slate-300 text-slate-800 rounded-xl font-bold text-[11px] transition">
                            Sightings
                        </button>
                        <button onclick="openAuditLogModal(${mp.id}, '${mp.full_name.replace(/'/g, "\\'")}')" class="px-2.5 py-1.5 bg-blue-100 hover:bg-blue-200 text-blue-800 rounded-xl font-bold text-[11px] transition">
                            Audit
                        </button>
                    </div>
                </div>
            `).join("");
        }

    } catch (err) {
        console.error("Failed to load authority dashboard metrics:", err);
        showToast("Error loading authority operations metrics.", "error");
    }
}

// ==================== NOTIFICATIONS (CATEGORY 13) ====================
async function fetchUnreadNotificationCount() {
    try {
        let notifCount = 0;
        if (currentUser && authToken) {
            const res = await fetch(`${API_BASE}/notifications/unread-count`, { headers: authHeaders() });
            if (res.ok) {
                const data = await res.json();
                notifCount = data.unread_count || 0;
            }
        }

        // Add active warning alerts count
        let alertCount = (currentAlerts || []).filter(a => a.is_active && isAlertMatchingUserLocation(a)).length;
        let totalCount = notifCount + alertCount;

        const badge = document.getElementById("unread-notification-count");
        const panelCount = document.getElementById("panel-unread-count");
        if (badge) {
            if (totalCount > 0) {
                badge.textContent = totalCount > 99 ? "99+" : totalCount;
                badge.classList.remove("hidden");
            } else {
                badge.classList.add("hidden");
            }
        }
        if (panelCount) {
            if (totalCount > 0) {
                panelCount.textContent = `${totalCount} active`;
                panelCount.classList.remove("hidden");
            } else {
                panelCount.classList.add("hidden");
            }
        }
    } catch (e) {
        console.warn("Failed to fetch unread notification count:", e);
    }
}

function toggleNotificationPanel() {
    const panel = document.getElementById("notification-panel");
    if (!panel) return;
    const isHidden = panel.classList.contains("hidden");
    if (isHidden) {
        panel.classList.remove("hidden");
        loadNotifications();
    } else {
        panel.classList.add("hidden");
    }
}

async function loadNotifications() {
    const listEl = document.getElementById("notification-list");
    if (!listEl) return;

    try {
        let notifs = [];
        if (currentUser && authToken) {
            const res = await fetch(`${API_BASE}/notifications/`, { headers: authHeaders() });
            if (res.ok) notifs = await res.json();
        }

        // Fetch active emergency warning alerts
        let activeAlerts = [];
        try {
            const alertsRes = await fetch(`${API_BASE}/alerts/?active_only=true`);
            if (alertsRes.ok) activeAlerts = await alertsRes.json();
        } catch(e) {}

        const activeWarnings = activeAlerts.filter(a => a.is_active);

        if (notifs.length === 0 && activeWarnings.length === 0) {
            listEl.innerHTML = `
                <div class="p-8 text-center text-slate-400 text-xs space-y-1">
                    <div class="text-xl">📭</div>
                    <div class="font-bold text-slate-600">No active notifications</div>
                    <div class="text-[10px]">Emergency warnings and system updates will appear here.</div>
                </div>
            `;
            return;
        }

        let html = "";

        // 1. Active Emergency Warnings at top of Notification Bell dropdown
        if (activeWarnings.length > 0) {
            html += `
                <div class="p-2 bg-red-50 border-b border-red-100 flex items-center justify-between text-[10px] font-black uppercase tracking-wider text-red-800">
                    <span class="flex items-center gap-1"><span>🚨</span> <span>Active Warnings (${activeWarnings.length})</span></span>
                    <button onclick="switchTab('alerts'); toggleNotificationPanel();" class="text-red-700 underline hover:text-red-900">View All &rarr;</button>
                </div>
            `;

            html += activeWarnings.map(a => {
                const isNearby = isAlertMatchingUserLocation(a);
                return `
                    <div onclick="switchTab('alerts'); toggleNotificationPanel();"
                        class="p-3.5 border-b border-red-100 hover:bg-red-50/60 transition cursor-pointer flex gap-3 text-xs bg-red-50/30">
                        <div class="text-lg shrink-0 mt-0.5">${isNearby ? '🚨' : '⚠️'}</div>
                        <div class="space-y-1 min-w-0 flex-1">
                            <div class="flex items-center justify-between gap-1 flex-wrap">
                                <span class="font-black text-red-950 truncate text-[11px]">${a.title}</span>
                                <span class="text-[9px] font-extrabold px-2 py-0.5 rounded-full ${isNearby ? 'bg-red-600 text-white animate-pulse' : 'bg-slate-200 text-slate-700'}">
                                    ${isNearby ? '📍 IN YOUR REGION' : a.target_region}
                                </span>
                            </div>
                            <p class="text-slate-700 text-[11px] leading-relaxed line-clamp-2">${a.message}</p>
                        </div>
                    </div>
                `;
            }).join("");
        }

        // 2. User System Activity Notifications
        if (notifs.length > 0) {
            html += `
                <div class="p-2 bg-slate-100 border-b border-slate-200 text-[10px] font-extrabold uppercase tracking-wider text-slate-600">
                    System Activity Updates
                </div>
            `;
            html += notifs.map(n => `
                <div onclick="markNotificationRead(${n.id})"
                    class="p-3.5 hover:bg-slate-50 transition cursor-pointer flex gap-3 text-xs ${n.is_read ? 'opacity-70 bg-white' : 'bg-blue-50/40'}">
                    <div class="w-2 h-2 rounded-full mt-1.5 shrink-0 ${n.is_read ? 'bg-transparent' : 'bg-blue-600 animate-pulse'}"></div>
                    <div class="space-y-1 min-w-0 flex-1">
                        <div class="flex items-center justify-between gap-2">
                            <span class="font-extrabold text-slate-900 truncate text-[11px]">${n.title}</span>
                            <span class="text-[9px] text-slate-400 font-mono shrink-0">${new Date(n.created_at).toLocaleTimeString("en-IN", {hour:"2-digit", minute:"2-digit", timeZone:"Asia/Kolkata"})}</span>
                        </div>
                        <p class="text-slate-600 text-[11px] leading-relaxed">${n.body}</p>
                    </div>
                </div>
            `).join("");
        }

        listEl.innerHTML = html;
    } catch (e) {
        console.error("Error loading notifications:", e);
        listEl.innerHTML = `<div class="p-6 text-center text-red-500 text-xs">Failed to load notifications.</div>`;
    }
}

async function markNotificationRead(notifId) {
    if (!currentUser || !authToken) return;
    try {
        await fetch(`${API_BASE}/notifications/${notifId}/read`, {
            method: "PATCH",
            headers: authHeaders()
        });
        fetchUnreadNotificationCount();
        loadNotifications();
    } catch (e) {
        console.error("Error marking notification read:", e);
    }
}

async function markAllNotificationsRead() {
    if (!currentUser || !authToken) return;
    try {
        await fetch(`${API_BASE}/notifications/read-all`, {
            method: "PATCH",
            headers: authHeaders()
        });
        showToast("All notifications marked as read", "success");
        fetchUnreadNotificationCount();
        loadNotifications();
    } catch (e) {
        console.error("Error marking all notifications read:", e);
    }
}

// Close notification panel when clicking outside
document.addEventListener("click", (e) => {
    const wrapper = document.getElementById("notification-bell-wrapper");
    const panel = document.getElementById("notification-panel");
    if (wrapper && panel && !wrapper.contains(e.target) && !panel.classList.contains("hidden")) {
        panel.classList.add("hidden");
    }
});

// ==================== OFFLINE SMS SOS CONTROLLER ====================
function updateSMSPreview() {
    const typeEl = document.getElementById("sms-emergency-type");
    const locEl = document.getElementById("sms-location");
    const latEl = document.getElementById("sms-lat");
    const lngEl = document.getElementById("sms-lng");
    const peopleEl = document.getElementById("sms-people-count");
    const phoneEl = document.getElementById("sms-my-phone");

    const type = typeEl ? typeEl.value : "EMERGENCY_SOS";
    const loc = locEl && locEl.value.trim() ? locEl.value.trim() : "Current Location";
    const lat = latEl ? latEl.value.trim() : "";
    const lng = lngEl ? lngEl.value.trim() : "";
    const people = peopleEl ? peopleEl.value : "1";
    const phone = phoneEl && phoneEl.value.trim() ? phoneEl.value.trim() : (currentUser?.phone_number || "");

    let gpsStr = (lat && lng) ? `GPS:${lat},${lng}` : "GPS:Pending";
    let msg = `🚨 SOS DISASTER: ${type} | PEOPLE:${people} | LOC:${loc} (${gpsStr}) | CONTACT:${phone} | NEED URGENT RESCUE`;

    const previewBox = document.getElementById("sms-preview-box");
    const countEl = document.getElementById("sms-char-count");
    if (previewBox) previewBox.textContent = msg;
    if (countEl) countEl.textContent = `${msg.length} chars (${Math.ceil(msg.length / 160)} SMS)`;
    return msg;
}

function detectOfflineSMSLocation() {
    if (!navigator.geolocation) {
        showToast("GPS not supported by device. Please enter location manually.", "warning");
        return;
    }
    showToast("Detecting offline device GPS coordinates...", "info");
    navigator.geolocation.getCurrentPosition(
        (pos) => {
            const lat = pos.coords.latitude.toFixed(4);
            const lng = pos.coords.longitude.toFixed(4);
            const latEl = document.getElementById("sms-lat");
            const lngEl = document.getElementById("sms-lng");
            if (latEl) latEl.value = lat;
            if (lngEl) lngEl.value = lng;
            updateSMSPreview();
            showToast(`Offline GPS Coordinates Set: ${lat}, ${lng}`, "success");
        },
        (err) => {
            showToast("Could not retrieve GPS coordinates. Please enter location text.", "warning");
        },
        { enableHighAccuracy: true, timeout: 8000 }
    );
}

function sendSMSDirect(targetNumber) {
    const msg = updateSMSPreview();
    const cleanNumber = targetNumber.replace(/[^0-9+]/g, '');
    
    // Construct standard mobile SMS URI
    const smsUri = `sms:${cleanNumber}?body=${encodeURIComponent(msg)}`;
    showToast(`Opening phone SMS app for ${cleanNumber}...`, "success");
    
    // Trigger mobile native SMS app
    window.location.href = smsUri;
}

function sendSMSCustomContact() {
    const customPhoneEl = document.getElementById("sms-custom-phone");
    const num = customPhoneEl ? customPhoneEl.value.trim() : "";
    if (!num) {
        showToast("Please enter a valid family/emergency phone number.", "warning");
        return;
    }
    sendSMSDirect(num);
}

// ==================== INITIALIZATION ====================
document.addEventListener("DOMContentLoaded", () => {
    OfflineManager.init();
    startISTClock();
    initSSE();
    checkAuthSession();
    switchTab("overview");
    updateSMSPreview();

    document.getElementById("form-report-disaster")?.addEventListener("submit", reportDisaster);
    document.getElementById("form-register-shelter")?.addEventListener("submit", registerShelter);
    document.getElementById("form-add-resource")?.addEventListener("submit", addResource);
    document.getElementById("form-request-resource")?.addEventListener("submit", submitResourceRequest);
    document.getElementById("form-broadcast-alert")?.addEventListener("submit", broadcastAlert);
    document.getElementById("form-register-missing")?.addEventListener("submit", handleRegisterMissingPerson);
    document.getElementById("form-found-suggestion")?.addEventListener("submit", handleFoundSuggestionSubmit);
});
