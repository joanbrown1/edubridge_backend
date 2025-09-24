const express = require("express");
const cors = require("cors");
const helmet = require("helmet");
const morgan = require("morgan");
const compression = require("compression");
const multer = require("multer");
const pdfParse = require("pdf-parse");
const mammoth = require("mammoth");
const rateLimit = require("express-rate-limit");
const sequelize = require("./db");
const bodyParser = require("body-parser");
const apiRoutes = require("./router");
require("dotenv").config();

sequelize.sync({ alter: true }).then(() => {
  console.log("Database synced ✅");
});

const app = express();
const PORT = process.env.PORT || 3001;

// --- Security & logging ---
app.use(
  helmet({
    contentSecurityPolicy: false,
  })
);
app.use(morgan("combined"));
app.use(compression());

// --- Core middlewares ---
app.use(cors());
app.use(bodyParser.json());
app.use(express.json({ limit: "10mb" }));
app.use(express.urlencoded({ extended: true, limit: "10mb" }));

// --- Rate limiting ---
const generalLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 50,
  message: { error: "Too many requests" },
});

const processingLimiter = rateLimit({
  windowMs: 5 * 60 * 1000,
  max: 15,
  message: { error: "Too many processing requests" },
});

// Apply rate limiters BEFORE route registration
app.use("/api/process-*", processingLimiter);
app.use("/api/", generalLimiter);

// --- User routes ---
app.use("/user", apiRoutes);

// --- File upload setup ---
const storage = multer.memoryStorage();
const upload = multer({
  storage,
  limits: { fileSize: 10 * 1024 * 1024 },
  fileFilter: (req, file, cb) => {
    const allowedTypes = [
      "application/pdf",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/msword",
      "text/plain",
    ];
    if (allowedTypes.includes(file.mimetype)) {
      cb(null, true);
    } else {
      cb(new Error("Invalid file type"));
    }
  },
});

class AIService {
  constructor() {
    this.apiKey = process.env.GOOGLE_API_KEY;
    this.baseURL =
      "https://generativelanguage.googleapis.com/v1beta/models/gemini-1.5-flash-latest:generateContent";
    this.requestDelay = 2000; // 2 seconds between requests
  }

  async makeRequest(prompt, retryCount = 0) {
    if (!this.apiKey) {
      console.warn("Google API key not found, using fallback");
      throw new Error("API key not configured");
    }

    try {
      const response = await fetch(`${this.baseURL}?key=${this.apiKey}`, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
        },
        body: JSON.stringify({
          contents: [
            {
              parts: [{ text: prompt }],
            },
          ],
          generationConfig: {
            temperature: 0.7,
            topK: 40,
            topP: 0.95,
            maxOutputTokens: 1024,
          },
        }),
      });

      if (!response.ok) {
        if (response.status === 429 && retryCount < 2) {
          console.log(
            `Rate limit hit, waiting ${
              this.requestDelay * (retryCount + 1)
            }ms...`
          );
          await new Promise((resolve) =>
            setTimeout(resolve, this.requestDelay * (retryCount + 1))
          );
          return this.makeRequest(prompt, retryCount + 1);
        }

        const errorData = await response.json().catch(() => ({}));
        throw new Error(
          `Gemini API error: ${errorData.error?.message || response.statusText}`
        );
      }

      const data = await response.json();

      if (!data.candidates?.[0]?.content?.parts?.[0]?.text) {
        throw new Error("Invalid API response");
      }

      return data.candidates[0].content.parts[0].text;
    } catch (error) {
      console.error("Gemini API request failed:", error.message);
      throw error;
    }
  }

  async generateSummary(text, level = "high-school") {
    const levelPrompts = {
      "middle-school":
        "Explain this using simple words a 12-year-old would understand",
      "high-school":
        "Explain this clearly for a high school student with helpful analogies",
      college: "Provide a comprehensive college-level explanation",
    };

    const prompt = `You are an expert tutor. ${levelPrompts[level]}.

Create a clear, engaging summary of this text in under 300 words:

${text.substring(0, 3000)}

Make it educational and accessible for ${level.replace("-", " ")} students.`;

    try {
      const response = await this.makeRequest(prompt);
      return response.trim();
    } catch (error) {
      console.log("Using fallback summary...");
      return this.generateFallbackSummary(text, level);
    }
  }

  async generateQuiz(text) {
    const prompt = `Create exactly 4 multiple-choice questions from this text.

Return ONLY a valid JSON array in this format:
[
  {
    "question": "Question text here?",
    "options": ["Option A", "Option B", "Option C", "Option D"],
    "correctIndex": 0,
    "explanation": "Why this answer is correct"
  }
]

No other text, just the JSON array.

Text: ${text.substring(0, 2500)}`;

    try {
      await new Promise((resolve) => setTimeout(resolve, this.requestDelay)); // Rate limiting delay
      const response = await this.makeRequest(prompt);
      return this.parseQuizResponse(response);
    } catch (error) {
      console.log("Using fallback quiz...");
      return this.generateFallbackQuiz(text);
    }
  }

  async generateFlashcards(text) {
    const prompt = `Create exactly 5 study flashcards from this text.

Return ONLY a valid JSON array in this format:
[
  {
    "front": "Question or key term",
    "back": "Clear, concise answer"
  }
]

No other text, just the JSON array.

Text: ${text.substring(0, 2500)}`;

    try {
      await new Promise((resolve) => setTimeout(resolve, this.requestDelay)); // Rate limiting delay
      const response = await this.makeRequest(prompt);
      return this.parseFlashcardResponse(response);
    } catch (error) {
      console.log("Using fallback flashcards...");
      return this.generateFallbackFlashcards(text);
    }
  }

  parseQuizResponse(response) {
    try {
      let cleanResponse = response
        .trim()
        .replace(/```json\s*/g, "")
        .replace(/```\s*/g, "");

      const jsonMatch = cleanResponse.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        cleanResponse = jsonMatch[0];
      }

      const parsed = JSON.parse(cleanResponse);

      if (Array.isArray(parsed)) {
        const validQuestions = parsed.filter(
          (q) =>
            q.question &&
            q.options &&
            Array.isArray(q.options) &&
            q.options.length === 4 &&
            typeof q.correctIndex === "number" &&
            q.correctIndex >= 0 &&
            q.correctIndex < 4
        );

        if (validQuestions.length > 0) {
          return validQuestions.slice(0, 4);
        }
      }

      throw new Error("No valid questions found");
    } catch (error) {
      console.error("Quiz parsing failed:", error.message);
      throw error;
    }
  }

  parseFlashcardResponse(response) {
    try {
      let cleanResponse = response
        .trim()
        .replace(/```json\s*/g, "")
        .replace(/```\s*/g, "");

      const jsonMatch = cleanResponse.match(/\[[\s\S]*\]/);
      if (jsonMatch) {
        cleanResponse = jsonMatch[0];
      }

      const parsed = JSON.parse(cleanResponse);

      if (Array.isArray(parsed)) {
        const validCards = parsed.filter(
          (card) =>
            card.front &&
            card.back &&
            typeof card.front === "string" &&
            typeof card.back === "string"
        );

        if (validCards.length > 0) {
          return validCards.slice(0, 5);
        }
      }

      throw new Error("No valid flashcards found");
    } catch (error) {
      console.error("Flashcard parsing failed:", error.message);
      throw error;
    }
  }

  // Improved fallback methods
  generateFallbackSummary(text, level) {
    const sentences = text.match(/[^.!?]+[.!?]+/g) || [];
    const words = text.toLowerCase().split(/\s+/);

    const commonWords = new Set([
      "the",
      "and",
      "or",
      "but",
      "in",
      "on",
      "at",
      "to",
      "for",
      "of",
      "with",
      "by",
      "is",
      "are",
      "was",
      "were",
      "be",
      "been",
      "have",
      "has",
      "had",
    ]);
    const keyTerms = [
      ...new Set(
        words.filter(
          (word) =>
            word.length > 4 && !commonWords.has(word) && /^[a-z]+$/.test(word)
        )
      ),
    ].slice(0, 6);

    const keySentences = [];
    if (sentences.length > 0) keySentences.push(sentences[0]);
    if (sentences.length > 2)
      keySentences.push(sentences[Math.floor(sentences.length / 2)]);
    if (sentences.length > 1)
      keySentences.push(sentences[sentences.length - 1]);

    return `This ${level.replace(
      "-",
      " "
    )} level content covers important concepts about ${keyTerms
      .slice(0, 3)
      .join(", ")}.

${keySentences.join(" ").trim()}

The material explains these key topics in detail: ${keyTerms
      .slice(0, 5)
      .join(
        ", "
      )}. Understanding these concepts helps build a solid foundation for further learning in this subject area.`;
  }

  generateFallbackFlashcards(text) {
    const sentences = text.match(/[^\.!?]+[\.!?]+/g) || [];
    const words = text.toLowerCase().split(/\s+/);

    // Extract key terms
    const commonWords = new Set([
      "the",
      "and",
      "or",
      "but",
      "in",
      "on",
      "at",
      "to",
      "for",
      "of",
      "with",
      "by",
    ]);
    const keyTerms = [
      ...new Set(
        words.filter(
          (word) =>
            word.length > 4 && !commonWords.has(word) && /^[a-z]+$/.test(word)
        )
      ),
    ].slice(0, 5);

    const cards = [];

    // Card 1: Main concept
    if (sentences.length > 0) {
      cards.push({
        front: "What is the main concept explained in this text?",
        back:
          sentences[0]
            .trim()
            .replace(/^[^A-Za-z]*/, "")
            .substring(0, 150) + (sentences[0].length > 150 ? "..." : ""),
      });
    }

    // Cards for key terms
    keyTerms.forEach((term) => {
      const relevantSentence = sentences.find((sentence) =>
        sentence.toLowerCase().includes(term)
      );

      if (relevantSentence) {
        cards.push({
          front: `What does "${term}" refer to in this context?`,
          back:
            relevantSentence.trim().substring(0, 150) +
            (relevantSentence.length > 150 ? "..." : ""),
        });
      } else {
        cards.push({
          front: `What is ${term}?`,
          back: `A key concept discussed in the text that is important for understanding the subject matter.`,
        });
      }
    });

    // Ensure we have at least 3 cards
    while (cards.length < 3) {
      cards.push({
        front: `What type of information does this text provide?`,
        back: `Educational content that explains important concepts and provides detailed information about the topic.`,
      });
    }

    return cards.slice(0, 5);
  }
}

const aiService = new AIService();

// Text extraction utilities
async function extractTextFromPDF(buffer) {
  try {
    const data = await pdfParse(buffer);
    return data.text;
  } catch (error) {
    throw new Error("Failed to extract text from PDF");
  }
}

async function extractTextFromDocx(buffer) {
  try {
    const result = await mammoth.extractRawText({ buffer });
    return result.value;
  } catch (error) {
    throw new Error("Failed to extract text from DOCX");
  }
}

// --- Routes ---
app.get("/api/health", (req, res) => {
  res.json({ status: "OK", timestamp: new Date().toISOString() });
});

app.post("/api/process-text", async (req, res) => {
  try {
    const { text, level = "high-school" } = req.body;

    if (!text || text.trim().length === 0) {
      return res.status(400).json({ error: "Text content is required" });
    }

    if (text.length > 10000) {
      return res
        .status(400)
        .json({ error: "Text too long. Maximum 10,000 characters allowed." });
    }

    // Generate all materials concurrently
    const [summary, quiz, flashcards] = await Promise.all([
      aiService.generateSummary(text, level),
      aiService.generateQuiz(text),
      aiService.generateFlashcards(text),
    ]);

    res.json({
      success: true,
      data: {
        originalText: text,
        summary,
        quiz,
        flashcards,
        metadata: {
          processedAt: new Date().toISOString(),
          textLength: text.length,
          level,
        },
      },
    });
  } catch (error) {
    console.error("Process text error:", error);
    res.status(500).json({
      error: "Failed to process text",
      details: error.message,
    });
  }
});

// Process uploaded file
app.post("/api/process-file", upload.single("file"), async (req, res) => {
  try {
    if (!req.file) {
      return res.status(400).json({ error: "No file uploaded" });
    }

    const { level = "high-school" } = req.body;
    let extractedText;

    // Extract text based on file type
    if (req.file.mimetype === "application/pdf") {
      extractedText = await extractTextFromPDF(req.file.buffer);
    } else if (req.file.mimetype.includes("word")) {
      extractedText = await extractTextFromDocx(req.file.buffer);
    } else {
      return res.status(400).json({ error: "Unsupported file type" });
    }

    if (!extractedText || extractedText.trim().length === 0) {
      return res
        .status(400)
        .json({ error: "No text could be extracted from the file" });
    }

    // Truncate if too long
    if (extractedText.length > 10000) {
      extractedText = extractedText.substring(0, 10000) + "...";
    }

    // Generate all materials concurrently
    const [summary, quiz, flashcards] = await Promise.all([
      aiService.generateSummary(extractedText, level),
      aiService.generateQuiz(extractedText),
      aiService.generateFlashcards(extractedText),
    ]);

    res.json({
      success: true,
      data: {
        originalText: extractedText,
        summary,
        quiz,
        flashcards,
        metadata: {
          processedAt: new Date().toISOString(),
          filename: req.file.originalname,
          fileSize: req.file.size,
          textLength: extractedText.length,
          level,
        },
      },
    });
  } catch (error) {
    console.error("Process file error:", error);
    res.status(500).json({
      error: "Failed to process file",
      details: error.message,
    });
  }
});

// Demo endpoint with sample content
app.get("/api/demo", async (req, res) => {
  try {
    const sampleText = `
    Photosynthesis is a complex biological process that occurs in plants, algae, and some bacteria. This process converts light energy, usually from the sun, into chemical energy in the form of glucose. The overall equation for photosynthesis is: 6CO₂ + 6H₂O + light energy → C₆H₁₂O₆ + 6O₂. The process occurs in two main stages: the light-dependent reactions (also called the photo part) and the light-independent reactions (also called the Calvin cycle). During the light-dependent reactions, chlorophyll absorbs light energy and uses it to split water molecules, releasing oxygen as a byproduct. The energy captured is used to produce ATP and NADPH. In the Calvin cycle, CO₂ from the atmosphere is fixed into organic molecules using the ATP and NADPH produced in the first stage.
    `;

    const [summary, quiz, flashcards] = await Promise.all([
      aiService.generateSummary(sampleText, "high-school"),
      aiService.generateQuiz(sampleText),
      aiService.generateFlashcards(sampleText),
    ]);

    res.json({
      success: true,
      data: {
        originalText: sampleText,
        summary,
        quiz,
        flashcards,
        metadata: {
          processedAt: new Date().toISOString(),
          textLength: sampleText.length,
          level: "high-school",
          isDemo: true,
        },
      },
    });
  } catch (error) {
    console.error("Demo error:", error);
    res.status(500).json({
      error: "Failed to generate demo content",
      details: error.message,
    });
  }
});

// --- Error handling ---
app.use((error, req, res, next) => {
  if (error instanceof multer.MulterError) {
    if (error.code === "LIMIT_FILE_SIZE") {
      return res
        .status(400)
        .json({ error: "File too large. Maximum size is 10MB." });
    }
    return res.status(400).json({ error: error.message });
  }
  console.error("Unhandled error:", error);
  res.status(500).json({ error: "Internal server error" });
});

// --- 404 ---
app.use("*", (req, res) => {
  res.status(404).json({ error: "Route not found" });
});

// --- Start server ---
app.listen(PORT, () => {
  console.log(`🚀 EduBridge backend server running on port ${PORT}`);
  console.log(`📚 Health check: http://localhost:${PORT}/api/health`);
});

module.exports = app;
