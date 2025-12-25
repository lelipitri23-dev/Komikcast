// --- 1. LOAD ENVIRONMENT VARIABLES (Wajib Paling Atas) ---
require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const path = require('path');
const cron = require('node-cron');
const session = require('express-session');
const {
  scrapeManga,
  scrapeChapterContent
} = require('./services/scraper');
const Manga = require('./models/Manga');
const Chapter = require('./models/Chapter');

const app = express();
// Ambil PORT dari .env, kalau tidak ada pakai 3000
const PORT = process.env.PORT || 3000;

// --- 2. KONFIGURASI DATABASE (Ambil dari .env) ---
const MONGODB_URI = process.env.MONGODB_URI;

if (!MONGODB_URI) {
  console.error("❌ FATAL ERROR: MONGODB_URI tidak ditemukan di file .env");
  process.exit(1);
}

mongoose.connect(MONGODB_URI)
.then(() => console.log('✅ Berhasil terkoneksi ke MongoDB Atlas'))
.catch(err => {
  console.error('❌ Gagal koneksi ke MongoDB:', err);
  process.exit(1);
});

// --- 3. CONFIG & MIDDLEWARE UTAMA ---
app.use(express.urlencoded({
  extended: true
}));
app.use(express.json());
app.use(express.static('public'));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Konfigurasi Session (Secret Ambil dari .env)
app.use(session( {
  secret: process.env.SESSION_SECRET || 'fallback_secret_kalau_lupa_set_env',
  resave: false,
  saveUninitialized: true,
  cookie: {
    maxAge: 24 * 60 * 60 * 1000
  } // 24 jam
}));

// --- 4. CUSTOM MIDDLEWARE (SATPAM) ---
const protectAdmin = (req, res, next) => {
  if (req.session && req.session.isAdmin) {
    return next();
  }
  res.redirect('/login');
};

// ==========================================
//                 ROUTES
// ==========================================

// --- A. AUTHENTICATION (Login/Logout) ---
app.get('/login', (req, res) => {
  if (req.session && req.session.isAdmin) return res.redirect('/admin');
  res.render('login', {
    error: null
  });
});

app.post('/login', (req, res) => {
  const {
    password
  } = req.body;
  const validPassword = process.env.ADMIN_PASSWORD;
  if (password === validPassword) {
    req.session.isAdmin = true;
    res.redirect('/admin');
  } else {
    res.render('login', {
      error: 'Password salah bosku!'
    });
  }
});

app.get('/logout', (req, res) => {
  req.session.destroy(() => {
    res.redirect('/login');
  });
});

// --- B. ADMIN PANEL (Protected) ---
app.get('/admin', protectAdmin, async (req, res) => {
  try {
    const totalKomik = await Manga.countDocuments();
    const mangas = await Manga.find()
      .select('title slug type rating lastUpdated sourceUrl status') 
      .sort({ lastUpdated: -1 })
      .limit(50)
      .lean();

    res.render('admin', { mangas, totalKomik });
  } catch (error) {
    res.status(500).send("Error membuka admin panel.");
  }
});



app.post('/admin/add-manga', protectAdmin, async (req, res) => {
  const {
    urls
  } = req.body; // Sekarang mengambil 'urls' dari textarea

  if (!urls) return res.redirect('/admin');

  try {
    // 1. Pecah text menjadi array berdasarkan baris baru (enter)
    const urlList = urls.split('\n')
    .map(u => u.trim()) // Hapus spasi di awal/akhir
    .filter(u => u.length > 0); // Hapus baris kosong

    console.log(`Admin meminta scrape ${urlList.length} URL.`);

    // 2. Loop dan scrape satu per satu
    for (const url of urlList) {
      if (url.startsWith('http')) {
        console.log(`Processing: ${url}`);
        await scrapeManga(url);

        // Beri jeda 2 detik antar request agar tidak dianggap DDOS oleh target
        await new Promise(resolve => setTimeout(resolve, 2000));
      }
    }

    res.redirect('/admin');
  } catch (error) {
    console.error("Scraping manual gagal:", error);
    res.send(`Gagal scrape. Cek terminal untuk detail.`);
  }
});

// --- C. PUBLIC PAGES (Halaman Utama) ---
app.get('/', async (req, res) => {
  try {
    // OPTIMISASI QUERY:
    const mangas = await Manga.find()
    .select('title slug coverImage type rating lastUpdated status chapters genres')
    .slice('chapters', 2)
    .sort({
      lastUpdated: -1
    })
    .limit(36)
    .lean();
    res.render('index', {
      mangas
    });
  } catch (error) {
    console.error(error);
    res.status(500).send("Terjadi kesalahan pada server.");
  }
});


// --- UPDATE ROUTE DAFTAR KOMIK (Filter & Sorting) ---
app.get('/daftar-komik', async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = 24; // Limit per halaman

  // Ambil parameter dari URL
  const {
    q,
    status,
    type,
    orderby,
    mode
  } = req.query;
  const genres = req.query['genre[]'] || req.query.genre; // Bisa string atau array

  try {
    // 1. Build Query Database
    let query = {};

    // Search keyword
    if (q) {
      query.title = {
        $regex: q,
        $options: 'i'
      };
    }

    // Filter Status (Ongoing/Completed)
    if (status && status !== 'all') {
      query.status = {
        $regex: status,
        $options: 'i'
      };
    }

    // Filter Type (Manga/Manhwa/Manhua)
    if (type && type !== 'all') {
      query.type = {
        $regex: type,
        $options: 'i'
      };
    }

    // Filter Genre (Logic: Komik harus punya SALAH SATU genre yang dipilih)
    if (genres) {
      const genreList = Array.isArray(genres) ? genres: [genres];
      // Gunakan regex untuk pencarian genre yang fleksibel
      const genreRegexes = genreList.map(g => new RegExp(g, 'i'));
      query.genres = {
        $in: genreRegexes
      };
    }

    // 2. Build Sorting
    let sort = {};
    switch (orderby) {
      case 'titleasc': sort = {
        title: 1
      }; break; // A-Z
      case 'titledesc': sort = {
        title: -1
      }; break; // Z-A
      case 'popular': sort = {
        rating: -1
      }; break; // Rating Tertinggi
      case 'update': default: sort = {
        lastUpdated: -1
      }; break; // Terbaru
    }

    // 3. Execute Query
    const totalKomik = await Manga.countDocuments(query);
    const mangas = await Manga.find(query)
    .select('title slug coverImage type rating lastUpdated genres status') // Optimasi select
    .sort(sort)
    .skip((page - 1) * limit)
    .limit(limit)
    .lean();

    // 4. Render dengan mengirimkan semua query params kembali ke view
    res.render('daftar', {
      mangas,
      currentPage: page,
      totalPages: Math.ceil(totalKomik / limit),
      queryParams: req.query, // Kirim parameter untuk menjaga state filter
      searchQuery: q || ''
  });

} catch (error) {
  console.error(error);
  res.status(500).send("Error memuat daftar komik.");
}
});

app.get('/popular', async (req, res) => {
  try {
    const mangas = await Manga.find()
      .select('title slug coverImage type rating author lastUpdated') // HANYA ambil data ini
      .sort({ rating: -1 })
      .limit(24) // Limit wajar
      .lean(); // Konversi ke JSON murni (Cepat)
      
    res.render('popular', { mangas });
  } catch (error) {
    res.status(500).send("Error memuat halaman popular.");
  }
});


app.get('/project', async (req, res) => {
  try {
    // Cari yang type-nya Manhwa (Komik Korea)
    // Gunakan regex agar tidak sensitif huruf besar/kecil
    const mangas = await Manga.find({ type: { $regex: 'Manhwa', $options: 'i' } })
      .select('title slug coverImage type rating lastUpdated chapters') // Ambil chapters
      .slice('chapters', 1) // TAPI CUMA AMBIL 1 CHAPTER TERATAS (Ringan!)
      .sort({ lastUpdated: -1 })
      .limit(24)
      .lean();

    res.render('project', { mangas });
  } catch (error) {
    res.status(500).send("Error memuat halaman project.");
  }
});


// --- D. DETAIL & BACA ---
app.get('/komik/:slug', async (req, res, next) => {
try {
const manga = await Manga.findOne({
slug: req.params.slug
});
if (!manga) return next(); // Lanjut ke 404 jika komik tidak ketemu
res.render('detail', {
manga
});
} catch (error) {
console.error(error);
res.status(500).send("Gagal memuat detail komik.");
}
});

// --- UPDATE ROUTE BACA (Agar Dropdown Chapter Berfungsi) ---
app.get('/baca/:mangaSlug/:chapterSlug', async (req, res) => {
const {
mangaSlug,
chapterSlug
} = req.params;
try {
// 1. Ambil Data Chapter
let chapter = await Chapter.findOne({
mangaSlug, chapterSlug
});

// 2. Ambil Data Manga (Untuk Judul Utama & Daftar List Chapter di Dropdown)
const manga = await Manga.findOne({
slug: mangaSlug
});
if (!manga) return res.status(404).send('Manga tidak ditemukan.');

// Jika chapter belum ada di DB chapter, coba scrape on-the-fly
if (!chapter) {
const targetChapter = manga.chapters.find(c => {
if (!c.url) return false;
const parts = c.url.split('/').filter(p => p);
return parts[parts.length - 1] === chapterSlug;
});

if (targetChapter) {
chapter = await scrapeChapterContent(targetChapter.url, mangaSlug, chapterSlug);
} else {
return res.status(404).send('Chapter tidak ditemukan.');
}
}

if (!chapter || !chapter.images || chapter.images.length === 0) {
return res.send('Gagal memuat gambar chapter.');
}

// 3. Render dengan data lengkap
res.render('chapter', {
chapter,
manga,
mangaSlug,
chapterSlug
});

} catch (error) {
console.error('Error Baca:', error);
res.status(500).send(`Error: ${error.message}`);
}
});

// --- E. FITUR LAIN (Search dengan Pagination) ---
app.get('/search', async (req, res) => {
const query = req.query.q;
const page = parseInt(req.query.page) || 1;
const limit = 24; // Batas per halaman

if (!query) return res.redirect('/');

try {
const dbQuery = {
title: {
$regex: query,
$options: 'i'
}
};

// 1. Hitung total data (untuk tahu jumlah halaman)
const totalData = await Manga.countDocuments(dbQuery);
const totalPages = Math.ceil(totalData / limit);

// 2. Ambil data sesuai halaman (Skip & Limit)
const results = await Manga.find(dbQuery)
.select('title slug coverImage type rating lastUpdated status') // Optimasi query
.sort({
lastUpdated: -1
}) // Urutkan dari yang terbaru (opsional)
.skip((page - 1) * limit)
.limit(limit)
.lean();

res.render('search', {
mangas: results,
searchQuery: query,
currentPage: page,
totalPages: totalPages
});

} catch (error) {
console.error(error);
res.status(500).send("Error search.");
}
});

app.get('/bookmark', (req, res) => {
res.render('bookmark');
});

app.post('/api/bookmarks', async (req, res) => {
const {
slugs
} = req.body;
if (!slugs || !Array.isArray(slugs)) return res.json([]);
try {
const mangas = await Manga.find({
slug: {
$in: slugs
}
});
res.json(mangas);
} catch (error) {
res.status(500).json({
error: 'Gagal ambil bookmark'
});
}
});

// --- GENRE PAGE (Pagination Limit 24) ---
app.get('/genres/:slug', async (req, res) => {
const slug = req.params.slug;
const page = parseInt(req.query.page) || 1;
const limit = 24; // Limit 24 per halaman

try {
// 1. Buat Query Regex untuk Genre
const regexPattern = slug.split('-').join('[- ]');
const query = {
genres: {
$regex: new RegExp(`^${regexPattern}$`, 'i')
}
};

// 2. Hitung Total Data (Untuk Pagination)
const totalData = await Manga.countDocuments(query);
const totalPages = Math.ceil(totalData / limit);

// 3. Ambil Data (Skip & Limit)
const mangas = await Manga.find(query)
.select('title slug coverImage type rating lastUpdated') // Optimasi: Hanya ambil field penting
.sort({
lastUpdated: -1
})
.skip((page - 1) * limit)
.limit(limit)
.lean();

// Format Judul Genre (misal: action-adventure -> Action Adventure)
const displayTitle = slug.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase());

res.render('genre', {
mangas,
genreName: displayTitle,
currentSlug: slug, // Penting untuk link pagination
currentPage: page,
totalPages: totalPages,
totalData: totalData
});

} catch (error) {
console.error(error);
res.status(500).send("Error memuat genre.");
}
});

// --- F. SEO & UTILS ---
app.get('/robots.txt', (req, res) => {
const baseUrl = `${req.protocol}://${req.get('host')}`;
res.type('text/plain');

// Menggunakan template literal (backticks) agar lebih rapi tanpa \n
res.send(`User-agent: *
Allow: /
Disallow: /admin/
Disallow: /api/
Disallow: /baca/
Disallow: /search
Disallow: /genres/
Sitemap: ${baseUrl}/sitemap_index.xml`);
});

// ==========================================
//           SITEMAP SYSTEM (YOAST STYLE)
// ==========================================

const SITEMAP_LIMIT = 1000; // Batas URL per file sitemap

// 1. SITEMAP INDEX (Induk)
app.get('/sitemap_index.xml', async (req, res) => {
try {
const baseUrl = `${req.protocol}://${req.get('host')}`;
const totalKomik = await Manga.countDocuments();
const totalKomikPages = Math.ceil(totalKomik / SITEMAP_LIMIT);

let xml = `<?xml version="1.0" encoding="UTF-8"?>
<?xml-stylesheet type="text/xsl" href="/main-sitemap.xsl"?>
<sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
<sitemap>
<loc>${baseUrl}/page-sitemap.xml</loc>
<lastmod>${new Date().toISOString()}</lastmod>
</sitemap>`;

// 2. Loop Sitemap Komik (komik-sitemap.xml, komik-sitemap-2.xml, dst)
// Jika ada 2500 komik, maka akan ada 3 file (page 1, 2, 3)
for (let i = 1; i <= totalKomikPages; i++) {
const suffix = i === 1 ? '': `-${i}`; // Halaman 1 tidak pakai angka, halaman 2 pakai -2
xml += `
<sitemap>
<loc>${baseUrl}/komik-sitemap${suffix}.xml</loc>
<lastmod>${new Date().toISOString()}</lastmod>
</sitemap>`;
}

xml += `</sitemapindex>`;

res.header('Content-Type', 'application/xml');
res.send(xml);

} catch (error) {
console.error("Error Sitemap Index:", error);
res.status(500).end();
}
});

// 2. SITEMAP PAGE (Halaman Statis)
app.get('/page-sitemap.xml', (req, res) => {
const baseUrl = `${req.protocol}://${req.get('host')}`;
const now = new Date().toISOString();

const staticPages = [{
url: '/',
priority: '1.0'
},
{
url: '/daftar-komik',
priority: '0.8'
},
{
url: '/popular',
priority: '0.8'
},
{
url: '/project',
priority: '0.8'
},
];

let xml = `<?xml version="1.0" encoding="UTF-8"?>
<?xml-stylesheet type="text/xsl" href="/main-sitemap.xsl"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">`;

staticPages.forEach(page => {
xml += `
<url>
<loc>${baseUrl}${page.url}</loc>
<lastmod>${now}</lastmod>
<changefreq>daily</changefreq>
<priority>${page.priority}</priority>
</url>`;
});

xml += `</urlset>`;
res.header('Content-Type', 'application/xml');
res.send(xml);
});

// 3. SITEMAP KOMIK DINAMIS (Support pagination: komik-sitemap.xml, komik-sitemap-2.xml)
app.get(/^\/komik-sitemap(-(\d+))?\.xml$/, async (req, res) => {
try {
const baseUrl = `${req.protocol}://${req.get('host')}`;

// Regex logic: Menangkap angka di URL. Jika tidak ada angka, berarti halaman 1.
// URL: /komik-sitemap.xml -> page 1
// URL: /komik-sitemap-2.xml -> page 2
const pageParam = req.params[1];
const page = pageParam ? parseInt(pageParam): 1;

// Hitung skip untuk database
const skip = (page - 1) * SITEMAP_LIMIT;

// Ambil data komik sesuai halaman
const mangas = await Manga.find()
.select('slug lastUpdated coverImage')
.sort({
lastUpdated: -1
})
.skip(skip)
.limit(SITEMAP_LIMIT);

// Jika halaman diminta tidak ada datanya (misal user ngetik sitemap-999.xml)
if (mangas.length === 0 && page > 1) {
return res.status(404).send('Sitemap not found');
}

// Header XML dengan Namespace Image (Agar kolom Images terhitung seperti Yoast)
let xml = `<?xml version="1.0" encoding="UTF-8"?>
<?xml-stylesheet type="text/xsl" href="/main-sitemap.xsl"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">`;

mangas.forEach(m => {
const date = m.lastUpdated ? new Date(m.lastUpdated).toISOString(): new Date().toISOString();

// Pastikan URL gambar valid
let imageXml = '';
if (m.coverImage && m.coverImage.startsWith('http')) {
imageXml = `
<image:image>
<image:loc>${m.coverImage}</image:loc>
</image:image>`;
}

xml += `
<url>
<loc>${baseUrl}/komik/${m.slug}</loc>
<lastmod>${date}</lastmod>
<changefreq>daily</changefreq>
<priority>0.6</priority>
${imageXml}
</url>`;
});

xml += `</urlset>`;

res.header('Content-Type',
'application/xml');
res.send(xml);

} catch (error) {
console.error("Error Sitemap Komik:",
error);
res.status(500).end();
}
});

// ==========================================
//           404 NOT FOUND MIDDLEWARE
// ==========================================
app.use((req, res, next) => {
res.status(404).render('404',
{
url: req.originalUrl
});
});

// --- CRON JOB ---
cron.schedule('0 * * * *', async () => {
console.log('⏰ [AUTO-UPDATE] Start...');
try {
const allMangas = await Manga.find({});
for (const manga of allMangas) {
if (manga.sourceUrl) {
await scrapeManga(manga.sourceUrl);
await new Promise(r => setTimeout(r, 5000));
}
}
console.log('✅ [AUTO-UPDATE] Selesai.');
} catch (error) {
console.error('❌ [AUTO-UPDATE] Error:', error);
}
});

// --- START SERVER ---
app.listen(PORT, () => {
console.log(`🚀 Server berjalan di http://localhost:${PORT}`);
});