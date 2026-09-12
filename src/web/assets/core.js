export const $ = (s) => document.querySelector(s);

export async function api(path, opts) {
  let res;
  try { res = await fetch(path, opts); }
  catch { const err = new Error("no response"); err.status = 0; throw err; }
  if (!res.ok) {
    let message = res.statusText;
    try { message = (await res.json()).error || message; } catch {}
    const err = new Error(message); err.status = res.status; throw err;
  }
  return res.json();
}

export const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) =>
  ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

export function describeError(err) {
  if (err?.status === 0) return "PlatWatch isn't answering — check the daemon is running.";
  if (err?.status === 404 && err.message === "not found")
    return "this page is newer than the running daemon — restart PlatWatch.";
  return err?.message || String(err);
}

export function toast(message, kind = "info") {
  const el = document.createElement("div");
  el.className = "toast " + kind;
  el.textContent = message;
  $("#toasts").append(el);
  setTimeout(() => el.remove(), kind === "error" ? 10000 : 3500);
}

export async function act(btn, fn) {
  if (btn.disabled) return false;
  const label = btn.textContent;
  btn.disabled = true;
  try { await fn(); return true; }
  catch (err) {
    btn.textContent = label; btn.classList.remove("done");
    toast(`${(btn.getAttribute("aria-label") || label).trim()} failed: ${describeError(err)}`, "error");
    return false;
  } finally { btn.disabled = false; }
}

export function placeholderRow(tbody, html) {
  const cols = tbody.closest("table").querySelectorAll("thead th").length || 1;
  tbody.innerHTML = `<tr class="placeholder"><td colspan="${cols}" class="empty">${html}</td></tr>`;
}

