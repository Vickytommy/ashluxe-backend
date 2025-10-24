// import fs from 'fs';
// import https from 'https';

const fs = require('fs');
const https = require('https');

const {Client}=require('pg');
const express = require('express')

const dotenv = require('dotenv').config();
const errorHandler = require("./middleware/errorHandler");

const app = express();
app.use(express.json());

const port = process.env.PORT || 5000;


const connection = new Client({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASS,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT,
  ssl: { rejectUnauthorized: false }
});

connection.connect()
  .then(() => console.log("Connected to PostgreSQL"))
  .catch(err => console.error("Connection error:", err));


app.get('/', (req, res) => {
    res.send('ASHLUXE WISHLIST API is running....');
});

// ADD COLLECTION
app.post("/api/wishlist/:wishlistId/collection", async (req, res) => {
  const { wishlistId } = req.params;
  const { title, first_name, last_name, image } = req.body;

  if (!title) {
    return res.status(400).json({ error: "Collection title is required" });
  }

  try {
    // 1️⃣ Check if wishlist exists
    let wishlistResult = await connection.query(
      "SELECT id, first_name, last_name, image FROM wishlist WHERE id = $1",
      [wishlistId]
    );

    // 2️⃣ If wishlist doesn't exist, create it
    if (wishlistResult.rowCount === 0) {
      if (!first_name || !last_name) {
        return res.status(400).json({ error: "first_name and last_name are required to create a new wishlist" });
      }

      const createWishlistResult = await connection.query(
        `INSERT INTO wishlist (id, first_name, last_name, image)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [wishlistId, first_name, last_name, image || null]
      );

      wishlistResult = createWishlistResult;
    }

    // 3️⃣ Insert new collection item linked to this wishlist
    const insertResult = await connection.query(
      `INSERT INTO collectionitem (title, wishlist_id)
       VALUES ($1, $2)
       RETURNING *`,
      [title, wishlistId]
    );

    res.status(201).json({
      message: "Collection added",
      wishlist: wishlistResult.rows[0],
      collection: insertResult.rows[0]
    });

  } catch (error) {
    console.error("Error adding collection:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET WISHLIST
app.get("/api/wishlist/:wishlistId", async (req, res) => {
  const { wishlistId } = req.params;

  try {
    // 1️⃣ Check if wishlist exists
    const wishlistResult = await connection.query(
      "SELECT * FROM wishlist WHERE id = $1",
      [wishlistId]
    );

    if (wishlistResult.rowCount === 0) {
      return res.status(404).json({ error: "Wishlist not found" });
    }

    const wishlist = wishlistResult.rows[0];

    // 2️⃣ Get all collection items linked to this wishlist
    const collectionsResult = await connection.query(
      "SELECT * FROM collectionitem WHERE wishlist_id = $1 ORDER BY created_at DESC",
      [wishlistId]
    );

    // 3️⃣ Attach collections to the wishlist object
    wishlist.collections = collectionsResult.rows;

    res.status(200).json({ wishlist });

  } catch (error) {
    console.error("Error fetching collections:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET COLLECTION BY ID
app.get("/api/collection/:collectionId", async (req, res) => {
  const { collectionId } = req.params;

  try {
    const result = await connection.query(`
      SELECT 
          c.*,
          to_jsonb(da) AS delivery_address,
          COALESCE(
            json_agg(DISTINCT jsonb_build_object(
              'id', p.id,
              'product_id', p.product_id,
              'product_handle', p.product_handle,
              'title', p.title,
              'description', p.description,
              'price', p.price,
              'image_url', p.image_url,
              'gifted', p.gifted,
              'quantity', p.quantity,
              'variant_id', p.variant_id
            )) FILTER (WHERE p.id IS NOT NULL), '[]'
          ) AS products
      FROM collectionitem c
      LEFT JOIN collectionitem_deliveryaddress da ON da.collectionitem_id = c.id
      LEFT JOIN collectionitem_product p ON p.collectionitem_id = c.id
      WHERE c.id = $1
      GROUP BY c.id, da.id
    `, [collectionId]);

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Collection item not found" });
    }

    res.json({ collection: result.rows[0] });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ADD PRODUCT TO COLLECTION
app.post("/api/collection/:collectionId/product", async (req, res) => {
  // Wishlist ID is passed in the body to verify ownership (it's same as customer id)
  const { collectionId } = req.params;
  const {
    wishlist_id,
    product_id,
    product_handle,
    title,
    description,
    price,
    image_url,
    gifted = 0,
    quantity = 1,
    variant_id
  } = req.body;

  try {
    // 1️⃣ Check if collectionitem exists AND belongs to the provided wishlist_id
    const collectionCheck = await connection.query(
      `SELECT id FROM collectionitem
       WHERE id = $1 AND wishlist_id = $2`,
      [collectionId, wishlist_id]
    );

    if (collectionCheck.rowCount === 0) {
      return res.status(404).json({ error: "Collection item not found for the provided wishlist" });
    }

    // 2️⃣ Check if product already exists in the collectionitem
    const duplicateCheck = await connection.query(
      `SELECT id FROM collectionitem_product
       WHERE collectionitem_id = $1 AND product_id = $2`,
      [collectionId, product_id]
    );

    if (duplicateCheck.rowCount > 0) {
      return res.status(400).json({ error: "Product already exists in this collection" });
    }

    // 3️⃣ Insert product into collectionitem_product
    const insertResult = await connection.query(
      `INSERT INTO collectionitem_product
        (collectionitem_id, product_id, product_handle, title, description, price, image_url, gifted, quantity, variant_id)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
       RETURNING *`,
      [collectionId, product_id, product_handle, title, description, price, image_url, gifted, quantity, variant_id]
    );

    res.status(201).json({
      message: "Product added to collection successfully",
      product: insertResult.rows[0]
    });

  } catch (err) {
    console.error("Error adding product to collection:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE PRODUCT FROM COLLECTION
app.delete("/api/collection/:collectionId/product/:productId", async (req, res) => {
  const { collectionId, productId } = req.params;
  const { wishlist_id } = req.body; // Pass wishlist_id in body

  try {
    // 1️⃣ Confirm collectionitem belongs to the wishlist
    const collectionCheck = await connection.query(
      `SELECT id FROM collectionitem
       WHERE id = $1 AND wishlist_id = $2`,
      [collectionId, wishlist_id]
    );

    if (collectionCheck.rowCount === 0) {
      return res.status(404).json({ error: "Collection item not found for the provided wishlist" });
    }

    // 2️⃣ Delete product from collectionitem_product
    const deleteResult = await connection.query(
      `DELETE FROM collectionitem_product
       WHERE collectionitem_id = $1 AND product_id = $2
       RETURNING *`,
      [collectionId, productId]
    );

    if (deleteResult.rowCount === 0) {
      return res.status(404).json({ error: "Product not found in this collection" });
    }

    res.json({
      message: "Product removed from collection successfully",
      product: deleteResult.rows[0]
    });

  } catch (err) {
    console.error("Error deleting product from collection:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// EDIT COLLECTION
app.put("/api/collection/:collectionId", async (req, res) => {
  const { collectionId } = req.params;
  const { wishlist_id, delivery_address, ...bodyFields } = req.body;

  try {
    // 1️⃣ Confirm collectionitem belongs to the wishlist
    const collectionCheck = await connection.query(
      `SELECT id FROM collectionitem WHERE id = $1 AND wishlist_id = $2`,
      [collectionId, wishlist_id]
    );

    if (collectionCheck.rowCount === 0) {
      return res.status(404).json({ error: "Collection item not found for the provided wishlist" });
    }

    // 2️⃣ Dynamically build UPDATE query for collectionitem
    const keys = Object.keys(bodyFields); // fields to update
    const values = Object.values(bodyFields);

    if (keys.length > 0) {
      const setQuery = keys.map((key, index) => `${key} = $${index + 1}`).join(", ");
      await connection.query(
        `UPDATE collectionitem
         SET ${setQuery}, updated_at = NOW()
         WHERE id = $${keys.length + 1}`,
        [...values, collectionId]
      );
    }

    // 3️⃣ Upsert delivery address if provided
    let updatedAddress = null;
    if (delivery_address) {
      const { house_number, apartment, country, postcode } = delivery_address;
      const addressResult = await connection.query(
        `INSERT INTO collectionitem_deliveryaddress
          (collectionitem_id, house_number, apartment, country, postcode)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (collectionitem_id)
         DO UPDATE SET
           house_number = EXCLUDED.house_number,
           apartment = EXCLUDED.apartment,
           country = EXCLUDED.country,
           postcode = EXCLUDED.postcode
         RETURNING *`,
        [collectionId, house_number, apartment, country, postcode]
      );
      updatedAddress = addressResult.rows[0];
    }

    // 4️⃣ Fetch all products for this collectionitem
    const productsResult = await connection.query(
      `SELECT * FROM collectionitem_product WHERE collectionitem_id = $1`,
      [collectionId]
    );

    // 5️⃣ Fetch updated collectionitem
    const collectionResult = await connection.query(
      `SELECT * FROM collectionitem WHERE id = $1`,
      [collectionId]
    );

    res.json({
      message: "Collection updated successfully",
      collection: collectionResult.rows[0],
      delivery_address: updatedAddress,
      products: productsResult.rows
    });

  } catch (err) {
    console.error("Error updating collection:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});



const httpsOptions = {
    key: fs.readFileSync('../server.key'),
    cert: fs.readFileSync('../server.crt')
};

https.createServer(httpsOptions, app).listen(port, () => {
    console.log(`HTTPS Server is running on port ${port}`);
});

// app.listen(port, () => {
//     console.log(`Server is running on port ${port}`);
// });