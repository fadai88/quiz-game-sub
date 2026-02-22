/**
 * services/botService.js
 * TriviaBot class, bot name picker, and adaptive difficulty selection.
 */

const logger = require('../logger');
const User   = require('../models/User');

// ─── Bot difficulty settings ──────────────────────────────────────────────────

const BOT_LEVELS = {
    MEDIUM: { correctRate: 0.7, responseTimeRange: [1500, 4000] },
    HARD:   { correctRate: 0.9, responseTimeRange: [1000, 3000] },
};

// ─── TriviaBot ────────────────────────────────────────────────────────────────

class TriviaBot {
    constructor(botName = 'BrainyBot', difficultyString = 'MEDIUM') {
        this.id                   = `bot-${Date.now()}`;
        this.username             = botName;
        this.score                = 0;
        this.totalResponseTime    = 0;
        this.difficultySetting    = BOT_LEVELS[difficultyString] || BOT_LEVELS.MEDIUM;
        this.difficultyLevelString = difficultyString;
        this.currentQuestionIndex = 0;
        this.answersGiven         = [];
        this.isBot                = true;
    }

    async answerQuestion(question, options, correctAnswer) {
        const willAnswerCorrectly = Math.random() < this.difficultySetting.correctRate;
        let botAnswer;

        if (willAnswerCorrectly) {
            botAnswer = correctAnswer;
        } else {
            const incorrectIndices = [];
            if (Array.isArray(options) && typeof correctAnswer === 'number' && correctAnswer >= 0 && correctAnswer < options.length) {
                for (let i = 0; i < options.length; i++) {
                    if (i !== correctAnswer) incorrectIndices.push(i);
                }
            }
            botAnswer = incorrectIndices.length > 0
                ? incorrectIndices[Math.floor(Math.random() * incorrectIndices.length)]
                : (Array.isArray(options) && options.length > 0 ? Math.floor(Math.random() * options.length) : 0);
        }

        const [minTime, maxTime] = this.difficultySetting.responseTimeRange;
        const responseTime = Math.floor(Math.random() * (maxTime - minTime)) + minTime;
        await new Promise(r => setTimeout(r, responseTime));

        this.totalResponseTime += responseTime;
        const isActuallyCorrect = (
            typeof botAnswer === 'number' && Array.isArray(options) &&
            typeof correctAnswer === 'number' && correctAnswer >= 0 &&
            correctAnswer < options.length && botAnswer === correctAnswer
        );
        if (isActuallyCorrect) this.score++;

        this.answersGiven.push({
            questionIndex: this.currentQuestionIndex++,
            answer: botAnswer, isCorrect: isActuallyCorrect, responseTime,
        });

        return { answer: botAnswer, responseTime, isCorrect: isActuallyCorrect };
    }

    getStats() {
        return {
            totalQuestionsAnswered: this.answersGiven.length,
            correctAnswers:         this.score,
            averageResponseTime:    this.totalResponseTime / Math.max(1, this.answersGiven.length),
            answersGiven:           this.answersGiven,
        };
    }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────

function chooseBotName() {
    const names = [
        'BrainyBot', 'QuizMaster', 'Trivia Titan', 'FactFinder',
        'QuestionQueen', 'KnowledgeKing', 'TriviaWhiz', 'WisdomBot',
        'FactBot', 'QuizGenius', 'BrainiacBot', 'TriviaLegend',
    ];
    return names[Math.floor(Math.random() * names.length)];
}

async function determineBotDifficulty(playerUsername) {
    try {
        const player = await User.findOne({ walletAddress: playerUsername });
        if (!player || player.gamesPlayed < 3) return 'MEDIUM';
        return (player.wins / player.gamesPlayed) < 0.4 ? 'MEDIUM' : 'HARD';
    } catch (error) {
        logger.error('Error determining bot difficulty:', { error });
        return 'HARD';
    }
}

module.exports = { TriviaBot, BOT_LEVELS, chooseBotName, determineBotDifficulty };