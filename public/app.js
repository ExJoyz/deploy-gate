// app.js — DeployGate launch board frontend (no framework, fetch + DOM).
'use strict';

const releasesEl = document.getElementById('releases');
const emptyState = document.getElementById('empty-state');

async function api(path, options) {
  const res = await fetch(path, {
    headers: { 'Content-Type': 'application/json' },
    ...options,
  });
  const data = await res.json().catch(() => ({}));
  if (!res.ok) throw new Error(data.error || `request failed: ${res.status}`);
  return data;
}

function esc(s) {
  return String(s)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;');
}

function itemRow(release, item) {
  return `<li class="${item.done ? 'done' : ''}" data-item-id="${item.id}">
    <input type="checkbox" data-testid="item-checkbox" ${item.done ? 'checked' : ''}
      aria-label="Mark '${esc(item.text)}' as done">
    <span>${esc(item.text)}</span>
    <button type="button" class="item-delete" data-testid="item-delete-btn"
      aria-label="Delete '${esc(item.text)}'">✕</button>
  </li>`;
}

function releaseCard(r) {
  const pending = r.items.filter((i) => !i.done);
  const completed = r.items.filter((i) => i.done);
  const statusClass = r.status === 'Deployed' ? 'status-deployed'
    : r.readyToDeploy ? 'status-ready' : 'status-draft';
  const statusLabel = r.status === 'Deployed' ? 'Deployed'
    : r.readyToDeploy ? 'Ready to deploy' : 'Draft';
  const hint = r.status === 'Deployed'
    ? `Deployed at ${new Date(r.deployedAt).toLocaleString()}.`
    : r.items.length === 0
      ? 'Add at least one checklist item before deploy is possible.'
      : r.done < r.total
        ? `${r.total - r.done} of ${r.total} checklist items still unchecked — Deploy is disabled.`
        : 'All items checked. Deploy is unlocked (Kane CLI still has to approve it).';

  return `<article class="release" data-release-id="${r.id}">
    <header>
      <h3>${esc(r.name)}</h3>
      <span class="status ${statusClass}" data-testid="release-status">${statusLabel}</span>
    </header>
    <p class="progress" data-testid="release-progress">${r.done} of ${r.total} checklist items done</p>

    <div class="checklist">
      <h4>Pending</h4>
      <ul data-testid="pending-list">
        ${pending.map((i) => itemRow(r, i)).join('') || '<li class="empty">Nothing pending.</li>'}
      </ul>
      <h4>Completed</h4>
      <ul data-testid="completed-list">
        ${completed.map((i) => itemRow(r, i)).join('') || '<li class="empty">Nothing completed yet.</li>'}
      </ul>
    </div>

    <form class="add-item">
      <label class="sr-only" for="item-input-${r.id}">Add checklist item</label>
      <input type="text" id="item-input-${r.id}" data-testid="item-input"
        placeholder="Add a checklist item…" required>
      <button type="submit" data-testid="add-item-btn">Add item</button>
    </form>

    <div class="deploy-row">
      <button type="button" class="deploy" data-testid="deploy-btn"
        ${r.readyToDeploy ? '' : 'disabled'}>Deploy</button>
      <p class="gate-hint" data-testid="deploy-hint">${esc(hint)}</p>
      <p class="deploy-msg" data-testid="deploy-msg" hidden></p>
    </div>
  </article>`;
}

async function render() {
  const { releases } = await api('/api/state');
  if (releases.length === 0) {
    releasesEl.innerHTML = '';
    releasesEl.appendChild(emptyState);
    return;
  }
  releasesEl.innerHTML = releases.map(releaseCard).join('');
}

// Create release
document.getElementById('create-form').addEventListener('submit', async (e) => {
  e.preventDefault();
  const input = document.getElementById('release-name-input');
  const name = input.value.trim();
  if (!name) return;
  await api('/api/releases', { method: 'POST', body: JSON.stringify({ name }) });
  input.value = '';
  await render();
});

// Delegated events inside the releases list.
releasesEl.addEventListener('submit', async (e) => {
  if (!e.target.matches('.add-item')) return;
  e.preventDefault();
  const card = e.target.closest('.release');
  const input = e.target.querySelector('[data-testid="item-input"]');
  const text = input.value.trim();
  if (!text) return;
  await api(`/api/releases/${card.dataset.releaseId}/items`, {
    method: 'POST',
    body: JSON.stringify({ text }),
  });
  await render();
});

releasesEl.addEventListener('change', async (e) => {
  if (!e.target.matches('[data-testid="item-checkbox"]')) return;
  const card = e.target.closest('.release');
  const itemId = e.target.closest('li').dataset.itemId;
  await api(`/api/releases/${card.dataset.releaseId}/items/${itemId}`, {
    method: 'PATCH',
    body: JSON.stringify({ done: e.target.checked }),
  });
  await render();
});

releasesEl.addEventListener('click', async (e) => {
  const card = e.target.closest('.release');
  if (!card) return;

  if (e.target.matches('[data-testid="item-delete-btn"]')) {
    const itemId = e.target.closest('li').dataset.itemId;
    await api(`/api/releases/${card.dataset.releaseId}/items/${itemId}`, { method: 'DELETE' });
    await render();
    return;
  }

  if (e.target.matches('[data-testid="deploy-btn"]')) {
    const msg = card.querySelector('[data-testid="deploy-msg"]');
    msg.hidden = false;
    msg.className = 'deploy-msg';
    msg.textContent = 'Deploying…';
    try {
      const updated = await api(`/api/releases/${card.dataset.releaseId}/deploy`, { method: 'POST' });
      msg.classList.add('ok');
      msg.textContent = `✅ Deployed at ${new Date(updated.deployedAt).toLocaleString()}.`;
    } catch (err) {
      msg.classList.add('err');
      msg.textContent = `⛔ Deploy blocked: ${err.message}`;
    }
    await render();
  }
});

render().catch((err) => {
  releasesEl.innerHTML = `<p class="empty">Failed to load releases: ${esc(err.message)}</p>`;
});
