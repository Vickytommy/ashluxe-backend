// /controllers/wishlistController.js
const db = require('../db');
const { v4: uuidv4 } = require('uuid');

// GET /api/wishlists/:id
async function getCollectionById(req, res, next) {
  try {
    const { id } = req.params;
    const { rows } = await db.query(
      `SELECT id, customer_id, title, visibility, views, items, created_at, updated_at
         FROM wishlists
        WHERE id = $1`,
      [id]
    );
    if (!rows.length) return res.status(404).json({ message: 'Wishlist not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
}

// GET /api/wishlists/customer/:customerId
async function getCollectionByCustomer(req, res, next) {
  try {
    const { customerId } = req.params;
    const { rows } = await db.query(
      `SELECT id, customer_id, title, visibility, views, items, created_at, updated_at
         FROM wishlists
        WHERE customer_id = $1
        ORDER BY created_at DESC`,
      [customerId]
    );
    res.json(rows);
  } catch (err) { next(err); }
}

// POST /api/wishlists
// body: { customer_id, title, visibility? }
async function addCollection(req, res, next) {
  try {
    const { customer_id, title, visibility = 'public' } = req.body || {};
    if (!customer_id || !title) {
      return res.status(400).json({ message: 'customer_id and title are required' });
    }

    const { rows } = await db.query(
      `INSERT INTO wishlists (customer_id, title, visibility)
       VALUES ($1, $2, $3)
       RETURNING id, customer_id, title, visibility, views, items, created_at, updated_at`,
      [customer_id, title, visibility]
    );
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
}

// PATCH /api/wishlists/:id
// body: any of { title, visibility, views }
async function updateCollection(req, res, next) {
  try {
    const { id } = req.params;
    const fields = [];
    const values = [];
    let idx = 1;

    ['title', 'visibility', 'views'].forEach((key) => {
      if (req.body[key] !== undefined) {
        fields.push(`${key} = $${idx++}`);
        values.push(req.body[key]);
      }
    });

    if (!fields.length) {
      return res.status(400).json({ message: 'No fields to update' });
    }

    // updated_at
    fields.push(`updated_at = now()`);

    const sql = `
      UPDATE wishlists
         SET ${fields.join(', ')}
       WHERE id = $${idx}
       RETURNING id, customer_id, title, visibility, views, items, created_at, updated_at
    `;
    values.push(id);

    const { rows } = await db.query(sql, values);
    if (!rows.length) return res.status(404).json({ message: 'Wishlist not found' });
    res.json(rows[0]);
  } catch (err) { next(err); }
}

// POST /api/wishlists/:id/items
// body: { product_handle, qty?, meta? }
async function addCollectionItem(req, res, next) {
  try {
    const { id } = req.params;
    const { product_handle, qty = 1, meta = {} } = req.body || {};
    if (!product_handle) {
      return res.status(400).json({ message: 'product_handle is required' });
    }

    const newItem = {
      id: uuidv4(),
      product_handle,
      qty,
      meta
    };

    const { rows } = await db.query(
      `
      UPDATE wishlists
         SET items = COALESCE(items, '[]'::jsonb) || to_jsonb($1::json),
             updated_at = now()
       WHERE id = $2
       RETURNING id, customer_id, title, visibility, views, items, created_at, updated_at
      `,
      [newItem, id]
    );

    if (!rows.length) return res.status(404).json({ message: 'Wishlist not found' });
    res.status(201).json(rows[0]);
  } catch (err) { next(err); }
}

// DELETE /api/wishlists/:id/items/:itemId
// removes by matching items[*].id
async function deleteCollectionItem(req, res, next) {
  try {
    const { id, itemId } = req.params;

    const { rows } = await db.query(
      `
      UPDATE wishlists
         SET items = COALESCE(
             (
               SELECT COALESCE(jsonb_agg(elem), '[]'::jsonb)
                 FROM jsonb_array_elements(items) AS elem
                WHERE elem->>'id' <> $1
             ),
             '[]'::jsonb
           ),
             updated_at = now()
       WHERE id = $2
       RETURNING id, customer_id, title, visibility, views, items, created_at, updated_at
      `,
      [itemId, id]
    );

    if (!rows.length) return res.status(404).json({ message: 'Wishlist not found' });
    res.status(200).json(rows[0]);
  } catch (err) { next(err); }
}

module.exports = {getCollectionById, getCollectionByCustomer, addCollection, updateCollection, addCollectionItem, deleteCollectionItem};