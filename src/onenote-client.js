'use strict';
/**
 * OneNote API Client — Microsoft Graph API v1.0
 *
 * Constructor: { getToken, dryRun } where getToken() returns current bearer token
 *              and getToken(true) forces a refresh.
 *              Legacy: { accessToken, dryRun } still accepted for backward compat.
 *
 * Scopes needed: Notes.Create, Notes.ReadWrite
 */
const fetch = require('node-fetch');
const FormData = require('form-data');

const GRAPH_BASE = 'https://graph.microsoft.com/v1.0/me/onenote';
const MAX_RETRIES = 5;
const BACKOFF_BASE_MS = 1000;
const BACKOFF_MAX_MS = 60_000;

class OneNoteClient {
  constructor({ getToken, accessToken, dryRun = false, globalBackoff = null } = {}) {
    this.dryRun = dryRun;
    this._globalBackoff = globalBackoff;
    if (getToken) {
      this._getToken = getToken;
    } else if (accessToken) {
      // Legacy path: wrap static token in a function
      this._getToken = () => accessToken;
    } else if (!dryRun) {
      throw new Error('OneNoteClient requires either getToken or accessToken');
    } else {
      this._getToken = () => { throw new Error('No token available (dry-run client used for live call)'); };
    }
  }

  async _token(forceRefresh = false) {
    return this._getToken(forceRefresh);
  }

  async getToken(forceRefresh = false) {
    return this._token(forceRefresh);
  }

  // ─── Public write methods ────────────────────────────────────────────────

  async createNotebook(name) {
    if (this.dryRun) {
      console.log(`  [dry-run] Would create notebook: "${name}"`);
      return { id: 'dry-run-notebook-id', displayName: name };
    }
    const existing = await this._get(`${GRAPH_BASE}/notebooks`);
    const found = existing.value.find(n => n.displayName === name);
    if (found) {
      console.log(`  Using existing notebook: "${name}"`);
      return found;
    }
    return this._post(`${GRAPH_BASE}/notebooks`, { displayName: name });
  }

  async createSection(notebookId, name) {
    if (this.dryRun) {
      console.log(`  [dry-run] Would create section: "${name}" in notebook ${notebookId}`);
      return { id: 'dry-run-section-id', displayName: name };
    }
    const existing = await this._get(`${GRAPH_BASE}/notebooks/${notebookId}/sections`);
    const found = existing.value.find(s => s.displayName === name);
    if (found) {
      console.log(`  Using existing section: "${name}"`);
      return found;
    }
    return this._post(`${GRAPH_BASE}/notebooks/${notebookId}/sections`, { displayName: name });
  }

  async createPage(sectionId, title, htmlContent) {
    if (this.dryRun) {
      console.log(`  [dry-run] Would create page: "${title}" in section ${sectionId}`);
      return { id: 'dry-run-page-id', title };
    }
    const url = `${GRAPH_BASE}/sections/${sectionId}/pages`;
    const token = await this._token();
    return this._fetchWithRetry(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'text/html',
      },
      body: htmlContent,
    });
  }

  /**
   * Create a page with binary attachments via multipart/form-data.
   *
   * @param {string} sectionId
   * @param {string} title
   * @param {string} htmlContent  — HTML with <img src="name:partN" /> or <object data="name:partN" />
   * @param {Array<{ contentType: string, data: Buffer, partName: string }>} resources
   */
  async createPageWithAttachments(sectionId, title, htmlContent, resources = []) {
    if (this.dryRun) {
      console.log(`  [dry-run] Would create page with ${resources.length} attachment(s): "${title}"`);
      return { id: 'dry-run-page-id', title };
    }

    const form = new FormData();

    // Presentation part must come first
    form.append('Presentation', htmlContent, {
      contentType: 'text/html',
      filename: 'Presentation',
    });

    for (const resource of resources) {
      form.append(resource.partName, resource.data, {
        contentType: resource.contentType,
        filename: resource.partName,
      });
    }

    const url = `${GRAPH_BASE}/sections/${sectionId}/pages`;
    const token = await this._token();
    return this._fetchWithRetry(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        ...form.getHeaders(),
      },
      body: form,
    });
  }

  async getOrCreateSectionGroup(notebookId, name) {
    if (this.dryRun) {
      console.log(`  [dry-run] Would create section group: "${name}" in notebook ${notebookId}`);
      return { id: 'dry-run-sectiongroup-id', displayName: name };
    }
    const existing = await this._get(`${GRAPH_BASE}/notebooks/${notebookId}/sectionGroups`);
    const found = (existing.value || []).find(g => g.displayName === name);
    if (found) return found;
    return this._post(`${GRAPH_BASE}/notebooks/${notebookId}/sectionGroups`, { displayName: name });
  }

  async createSectionInGroup(sectionGroupId, name) {
    if (this.dryRun) {
      console.log(`  [dry-run] Would create section: "${name}" in section group ${sectionGroupId}`);
      return { id: 'dry-run-section-in-group-id', displayName: name };
    }
    const existing = await this._get(`${GRAPH_BASE}/sectionGroups/${sectionGroupId}/sections`);
    const found = (existing.value || []).find(s => s.displayName === name);
    if (found) return found;
    return this._post(`${GRAPH_BASE}/sectionGroups/${sectionGroupId}/sections`, { displayName: name });
  }

  // ─── Public list/read methods ────────────────────────────────────────────

  async listNotebooks() {
    const results = [];
    let url = `${GRAPH_BASE}/notebooks`;
    while (url) {
      const page = await this._get(url);
      results.push(...(page.value || []));
      url = page['@odata.nextLink'] || null;
    }
    return results;
  }

  async listSections(notebookId) {
    const results = [];
    let url = `${GRAPH_BASE}/notebooks/${notebookId}/sections`;
    while (url) {
      const page = await this._get(url);
      results.push(...(page.value || []));
      url = page['@odata.nextLink'] || null;
    }
    return results;
  }

  async listPages(sectionId) {
    const results = [];
    let url = `${GRAPH_BASE}/sections/${sectionId}/pages`;
    while (url) {
      const page = await this._get(url);
      results.push(...(page.value || []));
      url = page['@odata.nextLink'] || null;
    }
    return results;
  }

  async findPageByTitle(sectionId, title) {
    if (this.dryRun) return null;
    // OData: escape embedded single quotes by doubling them
    const filter = `title eq '${title.replace(/'/g, "''")}'`;
    const url = `${GRAPH_BASE}/sections/${sectionId}/pages?$filter=${encodeURIComponent(filter)}&$select=id,title&$top=1`;
    const res = await this._get(url);
    return res.value && res.value.length > 0 ? res.value[0] : null;
  }

  async deletePage(pageId) {
    if (this.dryRun) {
      console.log(`  [dry-run] Would delete page ${pageId}`);
      return;
    }
    const url = `${GRAPH_BASE}/pages/${pageId}`;
    const token = await this._token();
    await this._fetchWithRetry(url, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${token}` },
    });
  }

  // ─── Internal helpers ────────────────────────────────────────────────────

  async _get(url) {
    const token = await this._token();
    return this._fetchWithRetry(url, {
      method: 'GET',
      headers: { Authorization: `Bearer ${token}` },
    });
  }

  async _post(url, body) {
    const token = await this._token();
    return this._fetchWithRetry(url, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(body),
    });
  }

  async _fetchWithRetry(url, options, attempt = 1) {
    const start = Date.now();
    let res;
    try {
      res = await fetch(url, options);
    } catch (networkErr) {
      if (attempt > MAX_RETRIES) throw networkErr;
      const delay = backoffDelay(attempt);
      console.warn(`  [network-error] ${networkErr.message} — retrying in ${(delay / 1000).toFixed(1)}s (attempt ${attempt}/${MAX_RETRIES})`);
      await sleep(delay);
      return this._fetchWithRetry(url, options, attempt + 1);
    }

    const duration = Date.now() - start;
    const method = options.method || 'GET';
    console.log(`  [api] ${method} ${url} → ${res.status} (${duration}ms)`);

    if (res.status === 429) {
      if (attempt > MAX_RETRIES) {
        throw new Error(`OneNote API rate limit exceeded after ${MAX_RETRIES} retries`);
      }
      const retryAfterMs = retryAfterDelayMs(res.headers);
      const delay = retryAfterMs ?? backoffDelay(attempt);
      // Signal all concurrent import tasks to pause for the same duration
      if (this._globalBackoff) this._globalBackoff.set(delay);
      console.warn(`  [rate-limit] 429 — waiting ${(delay / 1000).toFixed(1)}s (attempt ${attempt}/${MAX_RETRIES})`);
      await sleep(delay);
      return this._fetchWithRetry(url, options, attempt + 1);
    }

    if (res.status === 401) {
      if (attempt > 1) {
        throw new Error('OneNote API 401 after token refresh — authentication failed');
      }
      console.warn('  [auth] 401 received — refreshing token and retrying');
      const freshToken = await this._token(true);
      const refreshedOptions = {
        ...options,
        headers: {
          ...options.headers,
          Authorization: `Bearer ${freshToken}`,
        },
      };
      return this._fetchWithRetry(url, refreshedOptions, attempt + 1);
    }

    if (res.status === 409) {
      if (attempt > MAX_RETRIES) {
        const errBody = await res.text();
        throw new Error(`OneNote API conflict (409) after ${MAX_RETRIES} retries: ${errBody.slice(0, 200)}`);
      }
      const delay = retryAfterDelayMs(res.headers) ?? backoffDelay(attempt);
      console.warn(`  [conflict] 409 — retrying in ${(delay / 1000).toFixed(1)}s (attempt ${attempt}/${MAX_RETRIES})`);
      await sleep(delay);
      return this._fetchWithRetry(url, options, attempt + 1);
    }

    if (res.status === 503) {
      if (attempt > MAX_RETRIES) throw new Error('OneNote API 503 after max retries');
      const retryAfter503Ms = retryAfterDelayMs(res.headers);
      const delay = retryAfter503Ms ?? backoffDelay(attempt);
      console.warn(`  [service-unavailable] 503 — retrying in ${(delay / 1000).toFixed(1)}s (attempt ${attempt}/${MAX_RETRIES})`);
      await sleep(delay);
      return this._fetchWithRetry(url, options, attempt + 1);
    }

    if (res.status === 507) {
      throw new Error(
        'OneDrive storage full (507 Insufficient Storage). ' +
        'Free up space at https://onedrive.live.com before retrying. ' +
        'Import progress has been saved and can be resumed with --resume.'
      );
    }

    if (!res.ok) {
      const body = await res.text();
      const excerpt = body.length > 500 ? body.slice(0, 500) + '…' : body;
      throw new Error(`OneNote API error ${res.status}: ${excerpt}`);
    }

    const contentType = res.headers.get('content-type') || '';
    if (contentType.includes('application/json')) {
      return res.json();
    }
    return res.text();
  }
}

function backoffDelay(attempt) {
  const exp = Math.min(BACKOFF_BASE_MS * Math.pow(2, attempt - 1), BACKOFF_MAX_MS);
  return exp * (1 + Math.random() * 0.3);
}

function retryAfterDelayMs(headers) {
  const value = headers.get('Retry-After');
  if (value == null || value === '') return null;
  const seconds = Number.parseInt(value, 10);
  return Number.isFinite(seconds) && seconds >= 0 ? seconds * 1000 : null;
}

function sleep(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

module.exports = { OneNoteClient };
