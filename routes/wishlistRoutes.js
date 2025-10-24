// /routes/wishlistRoutes.js
const express = require('express');
const router = express.Router();
const ctrl = require('../controllers/wishlistController');

// Collections
router.get('/:id', ctrl.getCollectionById);
router.get('/customer/:customerId', ctrl.getCollectionByCustomer);
router.post('/', ctrl.addCollection);
router.patch('/:id', ctrl.updateCollection);

// Items inside a collection
router.post('/:id/items', ctrl.addCollectionItem);
router.delete('/:id/items/:itemId', ctrl.deleteCollectionItem);

module.exports = router;