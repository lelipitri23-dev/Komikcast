// --- 1. LOAD ENVIRONMENT VARIABLES (Wajib Paling Atas) ---
require('dotenv').config();

const express = require('express');
const mongoose = require('mongoose');
const path = require('path');
const cron = require('node-cron');
const session = require('express-session');
const { scrapeManga, scrapeChapterContent } = require('./services/scraper');
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
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(express.static('public'));
app.set('view engine', 'ejs');
app.set('views', path.join(__dirname, 'views'));

// Konfigurasi Session (Secret Ambil dari .env)
app.use(session({
  secret: process.env.SESSION_SECRET || 'fallback_secret_kalau_lupa_set_env',
  resave: false,
  saveUninitialized: true,
  cookie: { maxAge: 24 * 60 * 60 * 1000 } // 24 jam
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
  res.render('login', { error: null });
});

app.post('/login', (req, res) => {
  const { password } = req.body;
  const validPassword = process.env.ADMIN_PASSWORD;
  if (password === validPassword) {
    req.session.isAdmin = true;
    res.redirect('/admin');
  } else {
    res.render('login', { error: 'Password salah bosku!' });
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
    // 1. Hitung total semua komik untuk statistik
    const totalKomik = await Manga.countDocuments();

    // 2. Ambil hanya 15 komik terbaru untuk tabel
    const mangas = await Manga.find()
      .sort({ lastUpdated: -1 })
      .limit(15); // <--- INI BATASANNYA

    res.render('admin', { mangas, totalKomik }); // Kirim totalKomik juga
  } catch (error) {
    res.status(500).send("Error membuka admin panel.");
  }
});

app.post('/admin/add-manga', protectAdmin, async (req, res) => {
  const { urls } = req.body; // Sekarang mengambil 'urls' dari textarea

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
    // Tambahkan .limit(36) agar tidak memuat semua database sekaligus
    const mangas = await Manga.find()
      .sort({ lastUpdated: -1 })
      .limit(36);

    res.render('index', { mangas });
  } catch (error) {
    console.error(error);
    res.status(500).send("Terjadi kesalahan pada server.");
  }
});

app.get('/daftar-komik', async (req, res) => {
  const page = parseInt(req.query.page) || 1;
  const limit = 24;
  const search = req.query.q || '';

  try {
    const query = search ? { title: { $regex: search, $options: 'i' } } : {};
    const totalKomik = await Manga.countDocuments(query);
    const mangas = await Manga.find(query)
      .sort({ title: 1 })
      .skip((page - 1) * limit)
      .limit(limit);

    res.render('daftar', {
      mangas,
      currentPage: page,
      totalPages: Math.ceil(totalKomik / limit),
      searchQuery: search
    });
  } catch (error) {
    res.status(500).send("Error memuat daftar komik.");
  }
});

app.get('/popular', async (req, res) => {
  try {
    const mangas = await Manga.find().sort({ rating: -1 }).limit(20);
    res.render('popular', { mangas });
  } catch (error) {
    res.status(500).send("Error memuat halaman popular.");
  }
});

app.get('/project', async (req, res) => {
  try {
    const mangas = await Manga.find({ type: 'Manhwa' }).sort({ lastUpdated: -1 }).limit(20);
    res.render('project', { mangas });
  } catch (error) {
    res.status(500).send("Error memuat halaman project.");
  }
});

// --- D. DETAIL & BACA ---
app.get('/komik/:slug', async (req, res, next) => {
  try {
    const manga = await Manga.findOne({ slug: req.params.slug });
    if (!manga) return next(); // Lanjut ke 404 jika komik tidak ketemu
    res.render('detail', { manga });
  } catch (error) {
    console.error(error);
    res.status(500).send("Gagal memuat detail komik.");
  }
});

// --- UPDATE ROUTE BACA (Agar Dropdown Chapter Berfungsi) ---
app.get('/baca/:mangaSlug/:chapterSlug', async (req, res) => {
  const { mangaSlug, chapterSlug } = req.params;
  try {
    // 1. Ambil Data Chapter
    let chapter = await Chapter.findOne({ mangaSlug, chapterSlug });
    
    // 2. Ambil Data Manga (Untuk Judul Utama & Daftar List Chapter di Dropdown)
    const manga = await Manga.findOne({ slug: mangaSlug });
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

// --- E. FITUR LAIN (Search, Bookmark, Genre) ---
app.get('/search', async (req, res) => {
  const query = req.query.q;
  if (!query) return res.redirect('/');

  try {
    const results = await Manga.find({ title: { $regex: query, $options: 'i' } });
    res.render('search', { mangas: results, searchQuery: query });
  } catch (error) {
    res.status(500).send("Error search.");
  }
});

app.get('/bookmark', (req, res) => {
  res.render('bookmark');
});

app.post('/api/bookmarks', async (req, res) => {
  const { slugs } = req.body;
  if (!slugs || !Array.isArray(slugs)) return res.json([]);
  try {
    const mangas = await Manga.find({ slug: { $in: slugs } });
    res.json(mangas);
  } catch (error) {
    res.status(500).json({ error: 'Gagal ambil bookmark' });
  }
});

app.get('/genres/:slug', async (req, res) => {
  const slug = req.params.slug;
  try {
    const regexPattern = slug.split('-').join('[- ]');
    const mangas = await Manga.find({
      genres: { $regex: new RegExp(`^${regexPattern}$`, 'i') }
    }).sort({ lastUpdated: -1 });

    const displayTitle = slug.replace(/-/g, ' ').replace(/\b\w/g, l => l.toUpperCase());
    res.render('genre', { mangas, genreName: displayTitle });
  } catch (error) {
    res.status(500).send("Error genre.");
  }
});

// --- F. SEO & UTILS (HTTPS FIX) ---
app.get('/robots.txt', (req, res) => {
  // Logic: Kalau localhost pakai http, kalau live (Vercel) pakai https
  const protocol = req.get('host').includes('localhost') ? 'http' : 'https';
  const baseUrl = `${protocol}://${req.get('host')}`;
  
  res.type('text/plain');
  res.send(`User-agent: *
Allow: /
Disallow: /admin/
Disallow: /api/
Disallow: /baca/
Disallow: /search
Disallow: /genres/
Sitemap: ${baseUrl}/sitemap_index.xml`);
});

// --- SITEMAP SYSTEM ---
const SITEMAP_LIMIT = 1000;

app.get('/sitemap_index.xml', async (req, res) => {
  try {
    const protocol = req.get('host').includes('localhost') ? 'http' : 'https';
    const baseUrl = `${protocol}://${req.get('host')}`;
    const totalKomik = await Manga.countDocuments();
    const totalKomikPages = Math.ceil(totalKomik / SITEMAP_LIMIT);

    let xml = `<?xml version="1.0" encoding="UTF-8"?>
    <?xml-stylesheet type="text/xsl" href="/main-sitemap.xsl"?>
    <sitemapindex xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
      <sitemap>
        <loc>${baseUrl}/page-sitemap.xml</loc>
        <lastmod>${new Date().toISOString()}</lastmod>
      </sitemap>`;

    for (let i = 1; i <= totalKomikPages; i++) {
      const suffix = i === 1 ? '' : `-${i}`;
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
    res.status(500).end();
  }
});

app.get('/page-sitemap.xml', (req, res) => {
  const protocol = req.get('host').includes('localhost') ? 'http' : 'https';
  const baseUrl = `${protocol}://${req.get('host')}`;
  const now = new Date().toISOString();

  const staticPages = [
    { url: '/', priority: '1.0' },
    { url: '/daftar-komik', priority: '0.8' },
    { url: '/popular', priority: '0.8' },
    { url: '/project', priority: '0.8' },
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

app.get(/^\/komik-sitemap(-(\d+))?\.xml$/, async (req, res) => {
  try {
    const protocol = req.get('host').includes('localhost') ? 'http' : 'https';
    const baseUrl = `${protocol}://${req.get('host')}`;
    const pageParam = req.params[1];
    const page = pageParam ? parseInt(pageParam) : 1;
    const skip = (page - 1) * SITEMAP_LIMIT;

    const mangas = await Manga.find()
      .select('slug lastUpdated coverImage')
      .sort({ lastUpdated: -1 })
      .skip(skip)
      .limit(SITEMAP_LIMIT)
      .lean();

    if (mangas.length === 0 && page > 1) return res.status(404).send('Sitemap not found');

    let xml = `<?xml version="1.0" encoding="UTF-8"?>
    <?xml-stylesheet type="text/xsl" href="/main-sitemap.xsl"?>
    <urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"
            xmlns:image="http://www.google.com/schemas/sitemap-image/1.1">`;

    mangas.forEach(m => {
      const date = m.lastUpdated ? new Date(m.lastUpdated).toISOString() : new Date().toISOString();
      let imageXml = '';
      if (m.coverImage && m.coverImage.startsWith('http')) {
        imageXml = `<image:image><image:loc>${m.coverImage}</image:loc></image:image>`;
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
    res.header('Content-Type', 'application/xml');
    res.send(xml);
  } catch (error) {
    res.status(500).end();
  }
});

// ==========================================
//           404 NOT FOUND MIDDLEWARE
// ==========================================
app.use((req, res, next) => {
  res.status(404).render('404', { url: req.originalUrl });
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