/* ═══════════════════════════════════════════════════════════
   SERVICE WORKER — KOPERASI KELUARGA RENCO
   Strategi: Cache-First untuk aset statis, Network-First
   untuk API/Supabase, dengan fallback offline.
════════════════════════════════════════════════════════════ */

'use strict';

const CACHE_NAME    = 'renco-cache-v1';
const OFFLINE_URL   = '/';

/* ── Aset yang di-pre-cache saat install ── */
const PRE_CACHE_URLS = [
  '/',
  '/index.html',
  '/manifest.json',
  /* Tambahkan aset statis lain di sini jika ada, contoh:
  '/icons/icon-192x192.png',
  '/icons/icon-512x512.png',
  */
];

/* ── Domain yang tidak boleh di-cache (Supabase, CDN runtime) ── */
const NO_CACHE_PATTERNS = [
  /supabase\.co/,
  /googleapis\.com\/css/,    /* Google Fonts CSS — perlu network agar selalu fresh */
  /cdnjs\.cloudflare\.com/,
  /cdn\.jsdelivr\.net/,
];

/* ──────────────────────────────────────────
   INSTALL — pre-cache aset inti
────────────────────────────────────────── */
self.addEventListener('install', function(event) {
  console.log('[RENCO SW] Install v1');
  event.waitUntil(
    caches.open(CACHE_NAME)
      .then(function(cache) {
        return cache.addAll(PRE_CACHE_URLS);
      })
      .then(function() {
        /* Aktifkan langsung tanpa menunggu tab lama tutup */
        return self.skipWaiting();
      })
      .catch(function(err) {
        console.warn('[RENCO SW] Pre-cache gagal (mungkin offline saat install):', err.message);
        return self.skipWaiting();
      })
  );
});

/* ──────────────────────────────────────────
   ACTIVATE — hapus cache lama
────────────────────────────────────────── */
self.addEventListener('activate', function(event) {
  console.log('[RENCO SW] Activate');
  event.waitUntil(
    caches.keys().then(function(cacheNames) {
      return Promise.all(
        cacheNames
          .filter(function(name) { return name !== CACHE_NAME; })
          .map(function(name) {
            console.log('[RENCO SW] Hapus cache lama:', name);
            return caches.delete(name);
          })
      );
    }).then(function() {
      /* Ambil alih semua tab yang sudah terbuka */
      return self.clients.claim();
    })
  );
});

/* ──────────────────────────────────────────
   FETCH — strategi pencarian resource
────────────────────────────────────────── */
self.addEventListener('fetch', function(event) {
  const req = event.request;
  const url = new URL(req.url);

  /* Abaikan non-GET dan request dari ekstensi browser */
  if (req.method !== 'GET') return;
  if (url.protocol === 'chrome-extension:') return;
  if (url.protocol === 'moz-extension:') return;

  /* ── Tidak di-cache: Supabase API & CDN third-party ── */
  const skipCache = NO_CACHE_PATTERNS.some(function(pat) {
    return pat.test(req.url);
  });
  if (skipCache) {
    event.respondWith(networkOnly(req));
    return;
  }

  /* ── HTML (navigasi) → Network-First dengan fallback cache ── */
  if (req.mode === 'navigate' || req.headers.get('Accept').includes('text/html')) {
    event.respondWith(networkFirstThenCache(req));
    return;
  }

  /* ── Aset statis (JS/CSS/Font/Image) → Cache-First ── */
  event.respondWith(cacheFirstThenNetwork(req));
});

/* ──────────────────────────────────────────
   STRATEGI HELPER
────────────────────────────────────────── */

/**
 * Network-Only — untuk Supabase & API eksternal.
 * Gagal jaringan → kembalikan error Response agar app bisa tangani.
 */
async function networkOnly(req) {
  try {
    return await fetch(req);
  } catch (e) {
    return new Response(
      JSON.stringify({ error: 'Offline — tidak dapat menghubungi server' }),
      { status: 503, headers: { 'Content-Type': 'application/json' } }
    );
  }
}

/**
 * Network-First → jika berhasil, simpan ke cache.
 * Jika gagal → coba cache → jika tidak ada → fallback OFFLINE_URL.
 */
async function networkFirstThenCache(req) {
  const cache = await caches.open(CACHE_NAME);
  try {
    const netRes = await fetch(req);
    if (netRes.ok) {
      cache.put(req, netRes.clone());
    }
    return netRes;
  } catch (e) {
    const cached = await cache.match(req);
    if (cached) return cached;
    /* Fallback ke halaman utama yang sudah di-cache */
    const fallback = await cache.match(OFFLINE_URL);
    if (fallback) return fallback;
    return new Response(
      '<h2 style="font-family:sans-serif;padding:2rem">RENCO — Offline 📴<br><small>Buka kembali saat ada koneksi.</small></h2>',
      { status: 503, headers: { 'Content-Type': 'text/html;charset=UTF-8' } }
    );
  }
}

/**
 * Cache-First → jika tidak ada di cache, ambil dari network & simpan.
 */
async function cacheFirstThenNetwork(req) {
  const cache  = await caches.open(CACHE_NAME);
  const cached = await cache.match(req);
  if (cached) return cached;
  try {
    const netRes = await fetch(req);
    if (netRes.ok) {
      cache.put(req, netRes.clone());
    }
    return netRes;
  } catch (e) {
    /* Tidak ada di cache & offline — kembalikan 204 kosong */
    return new Response('', { status: 204 });
  }
}

/* ──────────────────────────────────────────
   MESSAGE — kontrol dari halaman utama
────────────────────────────────────────── */
self.addEventListener('message', function(event) {
  if (!event.data) return;

  /* Paksa update cache → kirim pesan { type: 'SKIP_WAITING' } */
  if (event.data.type === 'SKIP_WAITING') {
    self.skipWaiting();
  }

  /* Bersihkan seluruh cache → { type: 'CLEAR_CACHE' } */
  if (event.data.type === 'CLEAR_CACHE') {
    caches.delete(CACHE_NAME).then(function() {
      console.log('[RENCO SW] Cache dihapus oleh permintaan halaman');
    });
  }
});
