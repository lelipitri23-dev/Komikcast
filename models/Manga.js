const mongoose = require('mongoose');

const mangaSchema = new mongoose.Schema({
  title: { type: String, required: true },
  nativeTitle: String, // Contoh: 오늘만 사는 기사
  slug: { type: String, unique: true },
  coverImage: String,
  type: { type: String, default: 'Manga' }, // Manhwa/Manga
  rating: { type: Number, default: 0 },
  author: String,
  status: String, // Ongoing/Completed
  synopsis: String, // Menyimpan HTML sinopsis
  genres: [String],
  chapters: [{
    title: String, // Chapter 89
    slug: String,
    url: String, // URL asli chapter
    releaseDate: String
  }],
  sourceUrl: { type: String, unique: true },
  lastUpdated: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Manga', mangaSchema);