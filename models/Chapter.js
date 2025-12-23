// File: models/Chapter.js
const mongoose = require('mongoose');

const chapterSchema = new mongoose.Schema({
  mangaSlug: String,
  chapterSlug: String,
  title: String,
  images: [String],
  prevSlug: String,
  nextSlug: String,
  createdAt: { type: Date, default: Date.now }
});

module.exports = mongoose.model('Chapter', chapterSchema);