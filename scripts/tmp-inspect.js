const PROJECT = "crp-cuby-display";
const DATABASE = "(default)";

async function accessToken() {
  const auth = require("firebase-tools/lib/auth");
  const acc = auth.getGlobalDefaultAccount() || (auth.getAllAccounts() || [])[0];
  const { OAuth2Client } = require("google-auth-library");
  const c = new OAuth2Client(
    "https://accounts.google.com/o/oauth2/auth",
    "https://oauth2.googleapis.com/token",
  );
  c.setCredentials(acc.tokens);
  const { token } = await client2(c);
  return token;
}
async function client2(c) {
  return c.getAccessToken();
}

function decodeFields(fields = {}) {
  const one = (v) => {
    if (v === null || v === undefined) return undefined;
    if ("stringValue" in v) return v.stringValue;
    if ("integerValue" in v) return Number(v.integerValue);
    if ("booleanValue" in v) return v.booleanValue;
    if ("nullValue" in v) return null;
    if ("timestampValue" in v) return v.timestampValue;
    if ("arrayValue" in v) return (v.arrayValue.values || []).map(one);
    if ("mapValue" in v) return decodeFields(v.mapValue.fields || {});
    return undefined;
  };
  return Object.fromEntries(Object.entries(fields).map(([k, v]) => [k, one(v)]));
}

async function list(token, path) {
  const docs = [];
  let page = null;
  do {
    const url = new URL(
      `https://firestore.googleapis.com/v1/projects/${PROJECT}/databases/${DATABASE}/documents/${path}`,
    );
    url.searchParams.set("pageSize", "300");
    if (page) url.searchParams.set("pageToken", page);
    const res = await fetch(url, { headers: { Authorization: `Bearer ${token}` } });
    if (!res.ok) return { error: `${res.status}` };
    const json = await res.json();
    for (const d of json.documents || []) {
      docs.push({ id: d.name.split("/").pop(), ...decodeFields(d.fields) });
    }
    page = json.nextPageToken || null;
  } while (page);
  return docs;
}

(async () => {
  const token = await accessToken();
  const requests = await list(token, "requests");
  const markers = await list(token, "requestEmails");

  console.log("=== REQUESTS ===");
  for (const r of requests) {
    console.log(
      `${r.id}\n   email: ${r.email}\n   name: ${r.name}\n   status: ${r.status}\n   createdAt: ${r.createdAt}\n   testerId: ${r.testerId ?? "-"}\n   userId: ${r.userId ?? "-"}`,
    );
  }

  console.log("\n=== requestEmails MARKERS ===");
  for (const m of markers) {
    console.log(`${m.id.slice(0, 16)}... -> requestId: ${m.requestId} createdAt: ${m.createdAt}`);
  }
  console.log("\n=== meta ===", JSON.stringify(await list(token, "meta")));
})();