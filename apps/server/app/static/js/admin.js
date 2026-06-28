let activeTab = 'analytics';
    let cachedPlans = [];
    let cachedTemplates = [];
    let searchDebounceTimer = null;
    let currentModalTab = 'imagedefs';

    // Verify Storage on Load
    document.addEventListener("DOMContentLoaded", () => {
      const key = localStorage.getItem("media_assist_admin_key");
      if (key) {
        document.getElementById("auth-page").style.display = "none";
        document.getElementById("key-dot").classList.add("active");
        document.getElementById("key-label").textContent = "Connected";
        refreshDashboard();
      } else {
        document.getElementById("auth-page").style.display = "flex";
      }
    });

    function getAdminKey() {
      return localStorage.getItem("media_assist_admin_key") || "";
    }

    function saveAdminKey() {
      const key = document.getElementById("admin-key-input").value;
      if (!key) {
        showToast("Provide your API key", "error");
        return;
      }
      localStorage.setItem("media_assist_admin_key", key);
      document.getElementById("auth-page").style.display = "none";
      document.getElementById("key-dot").classList.add("active");
      document.getElementById("key-label").textContent = "Connected";
      showToast("Dashboard unlocked", "success");
      refreshDashboard();
    }

    function lockPanel() {
      localStorage.removeItem("media_assist_admin_key");
      document.getElementById("auth-page").style.display = "flex";
      document.getElementById("admin-key-input").value = "";
      document.getElementById("key-dot").classList.remove("active");
      document.getElementById("key-label").textContent = "Panel Locked";
      showToast("Logged out", "info");
    }

    async function apiRequest(url, method = "GET", body = null) {
      const headers = { "X-Admin-Key": getAdminKey() };
      if (body) headers["Content-Type"] = "application/json";
      
      const options = { method, headers };
      if (body) options.body = JSON.stringify(body);
      
      try {
        const res = await fetch(url, options);
        if (res.status === 401) {
          lockPanel();
          throw new Error("Credentials expired or invalid.");
        }
        const contentType = res.headers.get("content-type") || "";
        if (contentType.includes("octet-stream") && method === "GET") {
          return res;
        }
        let data = null;
        if (contentType.includes("application/json")) {
          data = await res.json();
        } else {
          const text = await res.text();
          data = { detail: text || res.statusText || "API Request failed." };
        }
        if (!res.ok) throw new Error(data.detail || `API request failed with HTTP ${res.status}.`);
        return data;
      } catch (err) {
        showToast(err.message, "error");
        throw err;
      }
    }

    function showToast(message, type = "success") {
      const stack = document.getElementById("toast-stack");
      const toast = document.createElement("div");
      toast.className = `toast ${type}`;
      toast.innerHTML = `<span>${message}</span>`;
      stack.appendChild(toast);
      setTimeout(() => {
        toast.style.opacity = '0';
        setTimeout(() => toast.remove(), 300);
      }, 3000);
    }

    function switchTab(tabId) {
      document.querySelectorAll(".nav-btn").forEach(btn => btn.classList.remove("active"));
      document.querySelectorAll(".dashboard-panel").forEach(p => p.classList.remove("active"));
      
      document.getElementById(`nav-${tabId}`).classList.add("active");
      document.getElementById(`panel-${tabId}`).classList.add("active");
      
      activeTab = tabId;
      
      const title = document.getElementById("page-title");
      const subtitle = document.getElementById("page-subtitle");
      
      if (tabId === 'analytics') {
        title.textContent = "System Analytics";
        subtitle.textContent = "Licensing database stats, ARR, and engine health snapshots";
        loadAnalytics();
      } else if (tabId === 'users') {
        title.textContent = "Accounts & Active Devices";
        subtitle.textContent = "Manage user credentials, plans, subscription expiries and active browser instances";
        loadUsers();
      } else if (tabId === 'plans') {
        title.textContent = "Subscription Plans";
        subtitle.textContent = "Link subscription levels to default settings templates and features";
        loadPlans();
      } else if (tabId === 'templates') {
        title.textContent = "Preconfigured Templates";
        subtitle.textContent = "Visual settings packages containing default image configurations, PDF rules and pipeline lists";
        loadTemplates();
      } else if (tabId === 'snapshots') {
        title.textContent = "System Snapshots";
        subtitle.textContent = "Generate consistent SQLite database backups and trigger hot restorations";
        loadSnapshots();
      } else if (tabId === 'settings') {
        title.textContent = "System Settings";
        subtitle.textContent = "Manage Telegram dumps, Rclone destinations, and backup rotation threshold values";
        loadSystemSettingsPanel();
      } else if (tabId === 'logs') {
        title.textContent = "Admin Audit Logs";
        subtitle.textContent = "Chronological view of operations executed on the administration portal";
        loadAuditLogs();
      }
    }

    function refreshDashboard() {
      switchTab(activeTab);
    }

    // --- TAB 1: ANALYTICS ---
    async function loadAnalytics() {
      try {
        const stats = await apiRequest("/v1/admin/dashboard/stats");
        document.getElementById("stat-users").textContent = stats.total_users;
        document.getElementById("stat-subs").textContent = stats.active_subscriptions;
        document.getElementById("stat-devices").textContent = stats.total_devices;
        document.getElementById("stat-arr").textContent = `₹${(stats.projected_arr / 100).toLocaleString('en-IN')}`;
        
        document.getElementById("stat-db-size").textContent = `${(stats.db_size_bytes / (1024 * 1024)).toFixed(2)} MB`;
        document.getElementById("stat-wal-size").textContent = `${(stats.wal_size_bytes / (1024 * 1024)).toFixed(2)} MB`;
        document.getElementById("stat-last-backup").textContent = stats.last_backup_at ? new Date(stats.last_backup_at).toLocaleString() : "Never";
      } catch (err) {}
    }

    // --- TAB 2: USERS ---
    async function loadUsers(search = "") {
      try {
        const users = await apiRequest(`/v1/admin/dashboard/users?search=${encodeURIComponent(search)}`);
        const tbody = document.getElementById("users-table-body");
        tbody.innerHTML = "";
        
        if (!users.length) {
          tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;color:var(--text-muted);">No profiles found.</td></tr>`;
          return;
        }

        users.forEach(u => {
          const hasActive = u.subscription_status === 'active';
          const planBadge = u.plan_name 
            ? `<span class="badge active" style="font-size:10px;">${u.plan_name}</span>`
            : `<span style="color:var(--text-muted);font-size:12px;">Free Profile</span>`;
            
          const statusBadge = hasActive 
            ? `<span class="badge active">Active</span>`
            : (u.subscription_status 
              ? `<span class="badge ${u.subscription_status}">${u.subscription_status}</span>` 
              : `<span class="badge expired">Inactive</span>`);

          const expiryDate = u.subscription_expires_at 
            ? new Date(u.subscription_expires_at).toLocaleDateString()
            : "-";

          const tr = document.createElement("tr");
          tr.innerHTML = `
            <td><strong>${u.email}</strong></td>
            <td>${statusBadge}</td>
            <td>${planBadge}</td>
            <td>${expiryDate}</td>
            <td>
              <button onclick="openDeviceManager('${u.id}')" class="btn sm" style="padding:4px 8px;">
                <span>${u.device_count} Active</span>
              </button>
            </td>
            <td style="font-family:monospace;font-size:12px;">r${u.settings_revision}</td>
            <td style="text-align:right;">
              <div style="display:inline-flex;gap:8px;">
                <button onclick="openSubscriptionModal('${u.id}', '${u.email}', '${u.plan_id || ''}', '${u.subscription_status || ''}', '${u.subscription_expires_at || ''}')" class="btn sm primary">Modify Plan</button>
                <button onclick="deleteUser('${u.id}', '${u.email}')" class="btn sm danger">Delete</button>
              </div>
            </td>
          `;
          tbody.appendChild(tr);
        });
      } catch (err) {}
    }

    function debounceUserSearch() {
      clearTimeout(searchDebounceTimer);
      searchDebounceTimer = setTimeout(() => {
        loadUsers(document.getElementById("user-search").value);
      }, 400);
    }

    async function deleteUser(id, email) {
      if (!confirm(`Permanently delete account ${email}? All synced settings and devices will be lost.`)) return;
      try {
        await apiRequest(`/v1/admin/dashboard/users/${id}`, "DELETE");
        showToast("Profile deleted", "success");
        loadUsers();
      } catch (err) {}
    }

    // Subscription Modal
    async function openSubscriptionModal(userId, email, planId, status, expiresAt) {
      document.getElementById("sub-modal-user-id").value = userId;
      document.getElementById("sub-modal-email").value = email;
      
      await loadCachedPlans();
      const select = document.getElementById("sub-modal-plan");
      select.innerHTML = "";
      
      cachedPlans.forEach(p => {
        const opt = document.createElement("option");
        opt.value = p.id;
        opt.textContent = `${p.name} (${p.id})`;
        select.appendChild(opt);
      });

      if (planId) select.value = planId;
      else if (cachedPlans.length) select.value = cachedPlans[0].id;

      onPlanSelectChange();

      if (status) document.getElementById("sub-modal-status").value = status;
      else document.getElementById("sub-modal-status").value = 'active';

      const expiresInput = document.getElementById("sub-modal-expires");
      if (expiresAt) {
        expiresInput.value = new Date(expiresAt).toISOString().slice(0, 16);
      } else {
        const date = new Date();
        date.setDate(date.getDate() + 365);
        expiresInput.value = date.toISOString().slice(0, 16);
      }

      openModal("subscription-modal");
    }

    function onPlanSelectChange() {
      const planId = document.getElementById("sub-modal-plan").value;
      const plan = cachedPlans.find(p => p.id === planId);
      if (plan) {
        const currency = document.getElementById("sub-modal-currency").value;
        document.getElementById("sub-modal-amount").value = currency === 'INR' ? plan.price_inr_minor : plan.price_usd_minor;
      }
    }

    async function loadCachedPlans() {
      cachedPlans = await apiRequest("/v1/admin/dashboard/plans");
    }

    async function saveSubscription() {
      const userId = document.getElementById("sub-modal-user-id").value;
      const planId = document.getElementById("sub-modal-plan").value;
      const amount = parseInt(document.getElementById("sub-modal-amount").value);
      const currency = document.getElementById("sub-modal-currency").value;
      const expires = document.getElementById("sub-modal-expires").value;
      const status = document.getElementById("sub-modal-status").value;

      if (isNaN(amount) || amount < 0) {
        showToast("Enter a valid price amount", "error");
        return;
      }
      if (!expires) {
        showToast("Select expiration date", "error");
        return;
      }

      const payload = {
        plan_id: planId,
        amount_minor: amount,
        currency,
        expires_at: new Date(expires).toISOString(),
        status
      };

      try {
        await apiRequest(`/v1/admin/dashboard/users/${userId}/subscription`, "PUT", payload);
        closeModal("subscription-modal");
        showToast("Subscription modified successfully", "success");
        loadUsers();
      } catch (err) {}
    }

    async function removeSubscription() {
      const userId = document.getElementById("sub-modal-user-id").value;
      if (!confirm("Revoke this subscription? user will revert to free plan.")) return;
      try {
        await apiRequest(`/v1/admin/dashboard/users/${userId}/subscription`, "DELETE");
        closeModal("subscription-modal");
        showToast("Subscription revoked", "success");
        loadUsers();
      } catch (err) {}
    }

    // Devices Manager
    async function openDeviceManager(userId) {
      document.getElementById("device-modal-user-id").value = userId;
      const listDiv = document.getElementById("device-modal-list");
      listDiv.innerHTML = "<p style='color:var(--text-muted);'>Loading devices...</p>";
      openModal("device-modal");

      try {
        const devices = await apiRequest(`/v1/admin/dashboard/users/${userId}/devices`);
        listDiv.innerHTML = "";
        if (!devices.length) {
          listDiv.innerHTML = "<p style='color:var(--text-muted);text-align:center;padding:12px;'>No active browser sessions.</p>";
          return;
        }

        devices.forEach(d => {
          const deviceCard = document.createElement("div");
          deviceCard.style.cssText = "display:flex;justify-content:space-between;align-items:center;padding:12px;background:#f8fafc;border:1px solid var(--border);border-radius:8px;";
          deviceCard.innerHTML = `
            <div>
              <strong>${d.name}</strong><br>
              <small style="color:var(--text-muted);">ID: ${d.device_id}</small><br>
              <small style="color:var(--text-muted);">Last seen: ${new Date(d.last_seen_at).toLocaleString()}</small>
            </div>
            <button onclick="revokeDevice('${userId}', '${d.device_id}')" class="btn sm danger">Revoke</button>
          `;
          listDiv.appendChild(deviceCard);
        });
      } catch (err) {}
    }

    async function revokeDevice(userId, deviceId) {
      if (!confirm("Revoke this session? Extension client will instantly log out.")) return;
      try {
        await apiRequest(`/v1/admin/dashboard/users/${userId}/devices/${deviceId}`, "DELETE");
        showToast("Device revoked", "success");
        openDeviceManager(userId);
      } catch (err) {}
    }

    // --- TAB 3: PLANS CRUD ---
    async function loadPlans() {
      try {
        const [plans, templates] = await Promise.all([
          apiRequest("/v1/admin/dashboard/plans"),
          apiRequest("/v1/admin/dashboard/templates")
        ]);
        cachedPlans = plans;
        cachedTemplates = templates;
        
        const tbody = document.getElementById("plans-table-body");
        tbody.innerHTML = "";
        
        if (!plans.length) {
          tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;color:var(--text-muted);">No plans defined yet.</td></tr>`;
          return;
        }

        plans.forEach(p => {
          const linkedTpl = templates.find(t => t.id === p.template_id);
          const tplText = linkedTpl 
            ? `<span class="badge active" style="background:#e0f2fe; color:#0369a1; border-color:#bae6fd;">${linkedTpl.name}</span>`
            : `<span style="color:var(--text-muted);font-size:12px;">-- None --</span>`;

          const tr = document.createElement("tr");
          tr.innerHTML = `
            <td><code style="font-family:monospace;font-weight:bold;">${p.id}</code></td>
            <td><strong>${p.name}</strong></td>
            <td><span class="badge active">${p.tier}</span></td>
            <td>₹${(p.price_inr_minor / 100).toFixed(2)}</td>
            <td>$${(p.price_usd_minor / 100).toFixed(2)}</td>
            <td>${p.duration_days} Days</td>
            <td>${tplText}</td>
            <td style="text-align:right;">
              <div style="display:inline-flex;gap:8px;">
                <button onclick="openEditPlanModal('${p.id}')" class="btn sm">Edit</button>
                <button onclick="deletePlan('${p.id}')" class="btn sm danger">Delete</button>
              </div>
            </td>
          `;
          tbody.appendChild(tr);
        });
      } catch (err) {}
    }

    async function openCreatePlanModal() {
      document.getElementById("plan-modal-title").textContent = "Create Plan";
      document.getElementById("plan-modal-mode").value = "create";
      document.getElementById("plan-modal-id").disabled = false;
      
      // Clear inputs
      document.getElementById("plan-modal-id").value = "";
      document.getElementById("plan-modal-name").value = "";
      document.getElementById("plan-modal-tier").value = "premium";
      document.getElementById("plan-modal-duration").value = "365";
      document.getElementById("plan-modal-price-inr").value = "50000";
      document.getElementById("plan-modal-price-usd").value = "499";
      
      // Features
      document.getElementById("feat-pipelines").checked = true;
      document.getElementById("feat-multi-input").checked = true;
      document.getElementById("feat-pinned").checked = true;

      

      openModal("plan-modal");
    }



    async function openEditPlanModal(planId) {
      const plan = cachedPlans.find(p => p.id === planId);
      if (!plan) return;

      document.getElementById("plan-modal-title").textContent = "Edit Plan";
      document.getElementById("plan-modal-mode").value = "edit";
      document.getElementById("plan-modal-id").value = plan.id;
      document.getElementById("plan-modal-id").disabled = true;
      
      document.getElementById("plan-modal-name").value = plan.name;
      document.getElementById("plan-modal-tier").value = plan.tier;
      document.getElementById("plan-modal-duration").value = plan.duration_days;
      document.getElementById("plan-modal-price-inr").value = plan.price_inr_minor;
      document.getElementById("plan-modal-price-usd").value = plan.price_usd_minor;

      // Features
      document.getElementById("feat-pipelines").checked = plan.features.includes("pipelines");
      document.getElementById("feat-multi-input").checked = plan.features.includes("multi_input_pipelines");
      document.getElementById("feat-pinned").checked = plan.features.includes("pinned_pipeline_buttons");

      

      openModal("plan-modal");
    }

    async function savePlan() {
      const mode = document.getElementById("plan-modal-mode").value;
      const id = document.getElementById("plan-modal-id").value.trim().toLowerCase();
      const name = document.getElementById("plan-modal-name").value.trim();
      const tier = document.getElementById("plan-modal-tier").value;
      const duration = parseInt(document.getElementById("plan-modal-duration").value);
      const priceInr = parseInt(document.getElementById("plan-modal-price-inr").value);
      const priceUsd = parseInt(document.getElementById("plan-modal-price-usd").value);
      if (!id || !name) {
        showToast("ID and display name are required.", "error");
        return;
      }

      // Read features
      const features = [];
      if (document.getElementById("feat-pipelines").checked) features.push("pipelines");
      if (document.getElementById("feat-multi-input").checked) features.push("multi_input_pipelines");
      if (document.getElementById("feat-pinned").checked) features.push("pinned_pipeline_buttons");

      const payload = {
        id, name, tier, duration_days: duration,
        price_inr_minor: priceInr, price_usd_minor: priceUsd,
        features
      };

      try {
        if (mode === 'create') {
          await apiRequest("/v1/admin/dashboard/plans", "POST", payload);
          showToast(`Plan created`, "success");
        } else {
          await apiRequest(`/v1/admin/dashboard/plans/${id}`, "PUT", payload);
          showToast(`Plan saved`, "success");
        }
        closeModal("plan-modal");
        loadPlans();
      } catch (err) {}
    }

    async function deletePlan(planId) {
      if (!confirm(`Delete plan template '${planId}'?`)) return;
      try {
        await apiRequest(`/v1/admin/dashboard/plans/${planId}`, "DELETE");
        showToast("Plan deleted", "success");
        loadPlans();
      } catch (err) {}
    }

    // --- TAB 4: TEMPLATES CRUD ---
    let currentTemplateCatTab = 'image_defaults';

    function switchTemplateCatTab(cat) {
      document.querySelectorAll('#panel-templates .modal-tab-btn').forEach(b => b.classList.remove('active'));
      document.getElementById('tpl-tab-' + cat).classList.add('active');
      currentTemplateCatTab = cat;
      loadTemplates();
    }

    async function loadTemplates() {
      try {
        const templates = await apiRequest("/v1/admin/dashboard/templates");
        cachedTemplates = templates;
        const tbody = document.getElementById("templates-table-body");
        tbody.innerHTML = "";
        
        const filtered = templates.filter(t => t.category === currentTemplateCatTab);
        
        if (!filtered.length) {
          tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;color:var(--text-muted);">No presets found in this category.</td></tr>`;
          return;
        }

        filtered.forEach(t => {
            const tr = document.createElement("tr");
            let size = Object.keys(t.payload || {}).length;
            if (Array.isArray(t.payload)) size = t.payload.length;
            
            tr.innerHTML = `
              <td><code style="font-family:monospace;font-weight:bold;">${t.id}</code></td>
              <td><strong>${t.name}</strong></td>
              <td>${size} configuration keys/steps</td>
              <td style="text-align:right;">
                <div style="display:inline-flex;gap:8px;">
                  <button onclick="openEditTemplateModal('${t.id}')" class="btn sm">Edit</button>
                  <button onclick="deleteTemplate('${t.id}')" class="btn sm danger">Delete</button>
                </div>
              </td>
            `;
            tbody.appendChild(tr);
        });
      } catch (err) {}
    }

    const templateTabByCategory = {
      image_defaults: 'imagedefs',
      merge_pdf: 'mergepdf',
      pipelines: 'pipelines'
    };
    const templateCategoryByTab = {
      imagedefs: 'image_defaults',
      mergepdf: 'merge_pdf',
      pipelines: 'pipelines'
    };

    function getNumberValue(id, fallback = undefined) {
      const value = document.getElementById(id).value;
      if (value === "") return fallback;
      const number = Number(value);
      return Number.isFinite(number) ? number : fallback;
    }

    function setNumberValue(id, value, fallback = "") {
      document.getElementById(id).value = value ?? fallback;
    }

    function switchModalTab(tabId) {
      document.querySelectorAll("#template-modal .modal-tab-btn").forEach(btn => btn.classList.remove("active"));
      document.querySelectorAll("#template-modal .modal-tab-content").forEach(c => c.classList.remove("active"));

      document.getElementById(`tab-btn-${tabId}`).classList.add("active");
      document.getElementById(`modal-sec-${tabId}`).classList.add("active");

      currentModalTab = tabId;
      document.getElementById("template-modal-category").value = templateCategoryByTab[tabId] || currentTemplateCatTab;
    }

    function fillTemplateForm(category, payload = {}) {
      document.getElementById("imgdef-format").value = payload.defaultFormat || "jpeg";
      setNumberValue("imgdef-maxkb", payload.defaultMaxKB, 180);
      document.getElementById("imgdef-crop").value = payload.defaultCropRatio || "free";
      setNumberValue("imgdef-quality", payload.defaultQuality, 90);
      setNumberValue("imgdef-minquality", payload.minimumQuality, 35);
      document.getElementById("imgdef-resizefit").value = payload.defaultResizeFit || "contain";
      document.getElementById("imgdef-filename").value = payload.defaultFilenameTemplate || "{datetime}";
      document.getElementById("imgdef-allowdim").checked = payload.allowDimensionReduction !== false;
      document.getElementById("imgdef-allowupscale").checked = payload.allowUpscale !== false;

      document.getElementById("merge-layout").value = payload.mergeDefaultLayout || "vertical";
      document.getElementById("merge-format").value = payload.mergeDefaultFormat || "jpeg";
      setNumberValue("merge-maxkb", payload.mergeDefaultMaxKB, 480);
      setNumberValue("merge-quality", payload.mergeDefaultQuality, 90);
      setNumberValue("merge-gap", payload.mergeDefaultGap, 36);
      setNumberValue("merge-padding", payload.mergeDefaultPadding, 72);
      setNumberValue("merge-border", payload.mergeDefaultBorderWidth, 3);
      document.getElementById("merge-bordercolor").value = payload.mergeDefaultBorderColor || "#d6d9dc";
      document.getElementById("merge-background").value = payload.mergeDefaultBackground || "#ffffff";
      setNumberValue("merge-gridcols", payload.mergeDefaultGridColumns, 2);

      document.getElementById("template-modal-pipelines").value = JSON.stringify(payload.steps ? payload : {
        inputCount: 1,
        pinned: true,
        mergeLayout: "vertical",
        background: "#ffffff",
        steps: [
          { type: "format", format: "jpeg" },
          { type: "compress", maxKB: 180 },
          { type: "download", automatic: true }
        ]
      }, null, 2);

      switchModalTab(templateTabByCategory[category] || "imagedefs");
    }

    function readTemplatePayload(category) {
      if (category === "image_defaults") {
        return {
          defaultFilenameTemplate: document.getElementById("imgdef-filename").value.trim() || "{datetime}",
          defaultFormat: document.getElementById("imgdef-format").value,
          defaultMaxKB: getNumberValue("imgdef-maxkb"),
          defaultQuality: getNumberValue("imgdef-quality", 90),
          minimumQuality: getNumberValue("imgdef-minquality", 35),
          allowDimensionReduction: document.getElementById("imgdef-allowdim").checked,
          allowUpscale: document.getElementById("imgdef-allowupscale").checked,
          defaultResizeFit: document.getElementById("imgdef-resizefit").value,
          defaultCropRatio: document.getElementById("imgdef-crop").value,
          removeSpacesByDefault: false,
          removeSpecialCharactersByDefault: true
        };
      }
      if (category === "merge_pdf") {
        return {
          mergeDefaultLayout: document.getElementById("merge-layout").value,
          mergeDefaultFormat: document.getElementById("merge-format").value,
          mergeDefaultMaxKB: getNumberValue("merge-maxkb"),
          mergeDefaultQuality: getNumberValue("merge-quality", 90),
          mergeDefaultGap: getNumberValue("merge-gap", 36),
          mergeDefaultPadding: getNumberValue("merge-padding", 72),
          mergeDefaultBorderWidth: getNumberValue("merge-border", 3),
          mergeDefaultBorderColor: document.getElementById("merge-bordercolor").value.trim() || "#d6d9dc",
          mergeDefaultBackground: document.getElementById("merge-background").value.trim() || "#ffffff",
          mergeDefaultGridColumns: getNumberValue("merge-gridcols", 2)
        };
      }
      try {
        const parsed = JSON.parse(document.getElementById("template-modal-pipelines").value || "{}");
        return Array.isArray(parsed) ? { steps: parsed } : parsed;
      } catch (e) {
        showToast("Invalid JSON syntax in pipeline payload.", "error");
        throw e;
      }
    }

    function openCreateTemplateModal() {
      const category = currentTemplateCatTab;
      document.getElementById("template-modal-title").textContent = "Create Preset Template";
      document.getElementById("template-modal-mode").value = "create";
      document.getElementById("template-modal-id").disabled = false;
      document.getElementById("template-modal-id").value = "";
      document.getElementById("template-modal-name").value = "";
      document.getElementById("template-modal-category").value = category;
      fillTemplateForm(category, {});
      openModal("template-modal");
    }

    function openEditTemplateModal(templateId) {
      const t = cachedTemplates.find(tpl => tpl.id === templateId);
      if (!t) return showToast("Template not found. Refresh and try again.", "error");

      document.getElementById("template-modal-title").textContent = "Edit Preset Template";
      document.getElementById("template-modal-mode").value = "edit";
      document.getElementById("template-modal-id").value = t.id;
      document.getElementById("template-modal-id").disabled = true;
      document.getElementById("template-modal-name").value = t.name;
      document.getElementById("template-modal-category").value = t.category;
      fillTemplateForm(t.category, t.payload || {});
      openModal("template-modal");
    }

    async function saveTemplate() {
      const mode = document.getElementById("template-modal-mode").value;
      const id = document.getElementById("template-modal-id").value.trim().toLowerCase();
      const name = document.getElementById("template-modal-name").value.trim();
      const category = document.getElementById("template-modal-category").value.trim();

      if (!id || !name) {
        showToast("ID and Template Name are required.", "error");
        return;
      }
      if (!["image_defaults", "merge_pdf", "pipelines"].includes(category)) {
        showToast("Choose a valid template category tab.", "error");
        return;
      }

      let payload;
      try {
        payload = readTemplatePayload(category);
      } catch {
        return;
      }

      const requestPayload = { id, name, category, payload };

      try {
        if (mode === 'create') {
          await apiRequest("/v1/admin/dashboard/templates", "POST", requestPayload);
          showToast(`Template created`, "success");
        } else {
          await apiRequest(`/v1/admin/dashboard/templates/${id}`, "PUT", requestPayload);
          showToast(`Template saved`, "success");
        }
        closeModal("template-modal");
        await loadTemplates();
      } catch (err) {}
    }

    async function deleteTemplate(templateId) {
      if (!confirm(`Delete template '${templateId}'?`)) return;
      try {
        await apiRequest(`/v1/admin/dashboard/templates/${templateId}`, "DELETE");
        showToast("Template deleted", "success");
        loadTemplates();
      } catch (err) {}
    }

    // --- TAB 5: SNAPSHOT BACKUPS ---
    async function loadSnapshots() {
      try {
        const backups = await apiRequest("/v1/admin/dashboard/backups");
        const tbody = document.getElementById("backups-table-body");
        tbody.innerHTML = "";
        
        if (!backups.length) {
          tbody.innerHTML = `<tr><td colspan="4" style="text-align:center;color:var(--text-muted);">No snapshot backups found.</td></tr>`;
          return;
        }

        backups.forEach(b => {
          const tr = document.createElement("tr");
          tr.innerHTML = `
            <td><strong>${b.filename}</strong></td>
            <td>${(b.size_bytes / (1024 * 1024)).toFixed(2)} MB</td>
            <td>${new Date(b.created_at).toLocaleString()}</td>
            <td style="text-align:right;">
              <div style="display:inline-flex;gap:8px;">
                <button onclick="downloadBackup('${b.filename}')" class="btn sm">Download</button>
                <button onclick="restoreBackup('${b.filename}')" class="btn sm warning">Restore Snapshot</button>
                <button onclick="deleteBackup('${b.filename}')" class="btn sm danger">Delete</button>
              </div>
            </td>
          `;
          tbody.appendChild(tr);
        });
      } catch (err) {}
    }

    async function createBackup() {
      showToast("Taking local snapshot...", "info");
      try {
        await apiRequest("/v1/admin/dashboard/backups", "POST");
        showToast("Database backup successfully saved", "success");
        loadSnapshots();
      } catch (err) {}
    }

    async function restoreBackup(filename) {
      if (!confirm(`🚨 CRITICAL Restoring database from snapshot: ${filename}?\nThis action will completely overwrite the active database. Proceed?`)) return;
      showToast("Restoring database state...", "info");
      try {
        await apiRequest(`/v1/admin/dashboard/backups/${filename}/restore`, "POST");
        showToast("System database restored successfully", "success");
        loadSnapshots();
      } catch (err) {}
    }

    async function deleteBackup(filename) {
      if (!confirm(`Delete snapshot file ${filename}?`)) return;
      try {
        await apiRequest(`/v1/admin/dashboard/backups/${filename}`, "DELETE");
        showToast("Backup file deleted", "success");
        loadSnapshots();
      } catch (err) {}
    }

    function downloadBackup(filename) {
      const a = document.createElement("a");
      a.href = `/v1/admin/dashboard/backups/${filename}/download?x_admin_key=${getAdminKey()}`;
      a.download = filename;
      a.click();
    }

    // --- TAB 6: SYSTEM SETTINGS ---
    async function loadSystemSettingsPanel() {
      try {
        const settings = await apiRequest("/v1/admin/dashboard/settings");
        document.getElementById("settings-auto-backup").checked = settings.auto_backup_enabled === "true";
        document.getElementById("settings-max-count").value = settings.max_backup_count;
        document.getElementById("settings-max-size").value = settings.max_backup_size_mb;
        document.getElementById("settings-telegram-token").value = settings.telegram_bot_token;
        document.getElementById("settings-telegram-chat").value = settings.telegram_chat_id;
        document.getElementById("settings-rclone-path").value = settings.rclone_remote_path;
        document.getElementById("settings-rclone-file").value = settings.rclone_config;
        document.getElementById("settings-razorpay-url").value = settings.razorpay_webhook_url || "";
        document.getElementById("settings-razorpay-secret").value = settings.razorpay_webhook_secret || "";
      } catch (err) {}
    }

    async function saveSystemSettings() {
      const payload = {
        auto_backup_enabled: document.getElementById("settings-auto-backup").checked ? "true" : "false",
        max_backup_count: document.getElementById("settings-max-count").value || "14",
        max_backup_size_mb: document.getElementById("settings-max-size").value || "100",
        telegram_bot_token: document.getElementById("settings-telegram-token").value.trim(),
        telegram_chat_id: document.getElementById("settings-telegram-chat").value.trim(),
        rclone_remote_path: document.getElementById("settings-rclone-path").value.trim(),
        rclone_config: document.getElementById("settings-rclone-file").value
      };

      try {
        await apiRequest("/v1/admin/dashboard/settings", "PUT", payload);
        showToast("System configurations saved", "success");
      } catch (err) {}
    }

    // --- TAB 7: AUDIT LOGS ---
    async function loadAuditLogs() {
      try {
        const logs = await apiRequest("/v1/admin/dashboard/audit-logs");
        const tbody = document.getElementById("logs-table-body");
        tbody.innerHTML = "";
        
        if (!logs.length) {
          tbody.innerHTML = `<tr><td colspan="3" style="text-align:center;color:var(--text-muted);">No audit logs recorded yet.</td></tr>`;
          return;
        }

        logs.forEach(l => {
          const tr = document.createElement("tr");
          tr.innerHTML = `
            <td style="font-family:monospace;font-size:12px;white-space:nowrap;">${new Date(l.created_at).toLocaleString()}</td>
            <td><span class="badge" style="background:#f1f5f9;border:1px solid var(--border);color:var(--text);">${l.action}</span></td>
            <td><code style="color:var(--text-muted);font-family:monospace;font-size:13px;">${l.details || '-'}</code></td>
          `;
          tbody.appendChild(tr);
        });
      } catch (err) {}
    }

    // Modal Helpers
    function openModal(id) { document.getElementById(id).classList.add("active"); }
    function closeModal(id) { document.getElementById(id).classList.remove("active"); }
