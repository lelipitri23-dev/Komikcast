const axios = require('axios');
const cheerio = require('cheerio');
const Manga = require('../models/Manga');
const Chapter = require('../models/Chapter');

// --- KONFIGURASI AXIOS ---
const AXIOS_OPTIONS = {
  headers: {
    'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
    'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,image/avif,image/webp,*/*;q=0.8',
    'Referer': 'https://google.com'
  },
  timeout: 10000 // Timeout 10 detik
};

/**
 * HELPER: Ekstrak Slug dari URL
 */
function getSlugFromUrl(url) {
  if (!url) return null;
  const cleanUrl = url.replace(/\/$/, ''); // Hapus slash di akhir
  const parts = cleanUrl.split('/');
  return parts[parts.length - 1]; // Ambil bagian terakhir
}

/**
 * FUNGSI 1: SCRAPE DETAIL KOMIK
 * Fitur: Smart Update & Anti-Duplicate
 */
async function scrapeManga(url) {
  try {
    console.log(`🔍 [Scraper] Mengunjungi Manga: ${url}`);
    const { data } = await axios.get(url, AXIOS_OPTIONS);
    const $ = cheerio.load(data);

    // 1. Ambil Slug dari URL
    const mangaSlug = getSlugFromUrl(url);
    if (!mangaSlug) throw new Error("Gagal mengambil slug dari URL");

    // 2. Metadata Dasar
    const title = $('.komik_info-content-body-title').text().trim();
    const nativeTitle = $('.komik_info-content-native').text().trim();

    // --- Handling Cover Image (Termasuk Relative URL) ---
    let coverImage = $('.komik_info-cover-image img').attr('src') ||
                     $('.komik_info-cover-image img').attr('data-src') ||
                     $('.komik_info-content-thumbnail img').attr('src');

    if (coverImage && !coverImage.startsWith('http')) {
      try {
        const baseUrl = new URL(url).origin;
        coverImage = baseUrl + (coverImage.startsWith('/') ? coverImage : '/' + coverImage);
      } catch (e) {
        console.log("Gagal memproses relative URL cover image");
      }
    }

    const ratingRaw = $('.data-rating').attr('data-ratingkomik');
    const rating = ratingRaw ? parseFloat(ratingRaw) : 0;
    const type = $('.komik_info-content-info-type a').text().trim() || 'Manga';

    let status = 'Unknown';
    let author = 'Unknown';
    $('.komik_info-content-info').each((i, el) => {
      const text = $(el).text();
      if (text.includes('Status:')) status = text.replace('Status:', '').trim();
      if (text.includes('Author:')) author = text.replace('Author:', '').trim();
    });

    const synopsis = $('.komik_info-description-sinopsis').html() || '<p>Sinopsis belum tersedia.</p>';
    const genres = [];
    $('.komik_info-content-genre a').each((i, el) => genres.push($(el).text().trim()));

    // 3. Scrape Daftar Chapter
    const chapters = [];
    $('#chapter-wrapper li.komik_info-chapters-item').each((i, el) => {
      const linkTag = $(el).find('a.chapter-link-item');
      const time = $(el).find('.chapter-link-time').text().trim();
      const chapterUrl = linkTag.attr('href');
      const chapterTitle = linkTag.text().replace(/\s+/g, ' ').trim();
      const chapterSlug = getSlugFromUrl(chapterUrl);

      if (chapterUrl && chapterSlug) {
        chapters.push({
          title: chapterTitle,
          url: chapterUrl,
          slug: chapterSlug,
          releaseDate: time
        });
      }
    });

    // --- LOGIKA MENCEGAH DUPLICATE KEY ERROR ---
    
    // Step A: Cari manga berdasarkan Source URL dulu (Paling Spesifik)
    let existingManga = await Manga.findOne({ sourceUrl: url });

    // Step B: Jika tidak ketemu by URL, cari by Slug (Fallback untuk data lama)
    if (!existingManga) {
        existingManga = await Manga.findOne({ slug: mangaSlug });
    }

    // --- LOGIKA SMART UPDATE (CEK CHAPTER BARU) ---
    let lastUpdatedTime = new Date(); // Default: Naik ke atas (jika baru/ada update)

    if (existingManga) {
        // Jika data sudah ada, cek apakah chapter paling atas berbeda?
        if (existingManga.chapters && existingManga.chapters.length > 0 && chapters.length > 0) {
            const latestScrapedUrl = chapters[0].url;
            const latestDbUrl = existingManga.chapters[0].url;

            if (latestScrapedUrl === latestDbUrl) {
                console.log(`⏸️ [Scraper] Tidak ada chapter baru: ${title}`);
                lastUpdatedTime = existingManga.lastUpdated; // Pakai waktu lama -> Posisi TETAP
            } else {
                console.log(`🔥 [Scraper] Chapter baru: ${title}! Naik ke atas.`);
                // lastUpdatedTime tetap new Date() -> Posisi NAIK
            }
        }
    }

    // 4. Simpan ke Database
    // PENTING: Gunakan _id untuk query update jika data sudah ada.
    // Ini mencegah MongoDB mencoba membuat dokumen baru yang menabrak index unique sourceUrl.
    const query = existingManga ? { _id: existingManga._id } : { slug: mangaSlug };

    const mangaData = await Manga.findOneAndUpdate(
      query,
      {
        sourceUrl: url,
        slug: mangaSlug, // Pastikan slug konsisten
        title,
        nativeTitle,
        coverImage,
        type,
        rating,
        author,
        status,
        synopsis,
        genres,
        chapters,
        lastUpdated: lastUpdatedTime
      },
      { upsert: true, new: true, setDefaultsOnInsert: true }
    );

    return mangaData;

  } catch (error) {
    // Tangani error duplicate key secara halus (jika masih terjadi)
    if (error.code === 11000) {
        console.error(`⚠️ [Scraper Warning] Duplicate Key untuk ${url}. Melewati...`);
    } else {
        console.error(`❌ [Scraper Error] Gagal scrape Manga (${url}):`, error.message);
    }
    return null;
  }
}

/**
 * FUNGSI 2: SCRAPE KONTEN CHAPTER
 */
async function scrapeChapterContent(url, mangaSlug, chapterSlug) {
  try {
    console.log(`📖 [Scraper] Mengambil Chapter: ${url}`);
    const { data } = await axios.get(url, AXIOS_OPTIONS);
    const $ = cheerio.load(data);

    // Ambil Judul
    const title = $('h1[itemprop="name"]').text().trim() || 
                  $('.chapter-content-title').text().trim() ||
                  'Chapter Unknown';

    // Ambil Gambar (Support Lazy Load)
    const images = [];
    $('.main-reading-area img').each((i, el) => {
      const $img = $(el);
      // Prioritas: data-src -> src -> data-lazy-src
      let src = $img.attr('data-src') || $img.attr('src') || $img.attr('data-lazy-src');

      if (src && src.trim() !== '') {
        src = src.trim();
        // Filter Iklan
        if (!src.includes('iklan') && !src.includes('ads') && !src.includes('histats')) {
           // Fix Protocol relative URL (//example.com -> https://example.com)
           if (src.startsWith('//')) src = 'https:' + src;
           images.push(src);
        }
      }
    });

    // Navigasi Next/Prev
    let nextSlug = null;
    let prevSlug = null;
    const nextLink = $('.nextprev a[rel="next"]').attr('href');
    const prevLink = $('.nextprev a[rel="prev"]').attr('href');

    if (nextLink) nextSlug = getSlugFromUrl(nextLink);
    if (prevLink) prevSlug = getSlugFromUrl(prevLink);

    if (images.length === 0) {
      throw new Error("Tidak ada gambar ditemukan (Mungkin layout web target berubah)");
    }

    // Simpan Chapter
    const chapterData = await Chapter.findOneAndUpdate(
      { mangaSlug, chapterSlug },
      { 
        title, 
        images, 
        nextSlug, 
        prevSlug,
        lastScraped: new Date() 
      },
      { upsert: true, new: true }
    );

    console.log(`✅ [Scraper] Chapter ${chapterSlug} tersimpan: ${images.length} gambar.`);
    return chapterData;

  } catch (error) {
    console.error(`❌ [Scraper Error] Gagal scrape Chapter (${url}):`, error.message);
    return null;
  }
}

module.exports = { scrapeManga, scrapeChapterContent };
