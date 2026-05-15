const mongoose = require('mongoose');

const SubscriptionSchema = new mongoose.Schema({
    userId: {
        type: mongoose.Schema.Types.ObjectId,
        ref: 'User',
        required: true,
        index: true
    },
    walletAddress: {
        type: String,
        required: true,
        index: true
    },
    status: {
        type: String,
        enum: ['active', 'expired', 'cancelled', 'pending'],
        default: 'pending',
        index: true
    },
    tier: {
        type: String,
        enum: ['free', 'premium'],
        default: 'free'
    },
    amount: {
        type: Number,
        required: true,
        min: 0
    },
    currency: {
        type: String,
        enum: ['USDC', 'SOL'],
        default: 'USDC'
    },
    startDate: {
        type: Date,
        required: true
    },
    endDate: {
        type: Date,
        required: true,
        index: true
    },
    autoRenew: {
        type: Boolean,
        default: false
    },
    transactionSignature: {
        type: String,
        required: true,
        unique: true
    },
    renewalTransactionSignature: {
        type: String,
        sparse: true
    },
    metadata: {
        type: mongoose.Schema.Types.Mixed,
        default: {}
    }
}, {
    timestamps: true
});

// Index for finding subscriptions that need renewal
SubscriptionSchema.index({ status: 1, endDate: 1, autoRenew: 1 });

// Static method to check if user has active subscription
SubscriptionSchema.statics.hasActiveSubscription = async function(userId) {
    const subscription = await this.findOne({
        userId,
        status: 'active',
        endDate: { $gt: new Date() }
    });
    return !!subscription;
};

// Static method to get active subscription
SubscriptionSchema.statics.getActiveSubscription = async function(userId) {
    return this.findOne({
        userId,
        status: 'active',
        endDate: { $gt: new Date() }
    });
};

// Method to check if subscription is expired
SubscriptionSchema.methods.isExpired = function() {
    return this.endDate < new Date();
};

// Method to renew subscription
SubscriptionSchema.methods.renew = async function(transactionSignature, months = 1) {
    this.renewalTransactionSignature = transactionSignature;
    this.endDate = new Date(this.endDate.getTime() + (months * 30 * 24 * 60 * 60 * 1000));
    this.status = 'active';
    return await this.save();
};

// Method to cancel subscription
SubscriptionSchema.methods.cancel = async function() {
    this.status = 'cancelled';
    this.autoRenew = false;
    return await this.save();
};

const Subscription = mongoose.model('Subscription', SubscriptionSchema);

module.exports = Subscription;
