// import fs from 'fs';
// import https from 'https';

// const fs = require('fs');
// const https = require('https');

const {Client}=require('pg');
const {S3Client, PutObjectCommand, GetObjectCommand} = require('@aws-sdk/client-s3');
const { getSignedUrl } = require('@aws-sdk/s3-request-presigner');
const express = require('express')
const cors = require('cors');
const multer = require('multer');
const sharp = require('sharp');

const dotenv = require('dotenv').config();
const errorHandler = require("./middleware/errorHandler");

const app = express();
app.use(express.json());

app.use(cors({
  origin: [
    'https://ash-luxe.com', 
    'https://www.ash-luxe.com', 
    "https://ashluxury.com", 
    "https://www.ashluxury.com",
    "https://extensions.shopifycdn.com"

  ], // allowed frontends
  methods: ['GET', 'POST', 'PUT', 'DELETE', 'OPTIONS'],
  credentials: true
}));

const storage = multer.memoryStorage();
const upload = multer({ storage: storage });

const s3 = new S3Client({
  // credentials: {
  //   accessKeyId: process.env.ACCESS_KEY,
  //   secretAccessKey: process.env.SECRET_ACCESS_KEY
  // },
  region: process.env.BUCKET_REGION
})

const shopify_endpoint = "https://www.ashluxe.myshopify.com";
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

async function getImageUrl(imageName) {
  const getObjectParams = {
    Bucket: process.env.BUCKET_NAME,
    Key: imageName
  };
  const getCommand = new GetObjectCommand(getObjectParams);
  const url = await getSignedUrl(s3, getCommand, { expiresIn: 3600 });
  return url;
}

app.get('/', (req, res) => {
  res.send('ASHLUXE WISHLIST API is running....');
});

// UPLOAD PROFILE IMG
app.post("/api/wishlist/:wishlistId/upload", upload.single('profileImg'), async (req, res) => {
  const { wishlistId } = req.params;

  try {
    // 1️⃣ Validate required fields
    if (!req.file) {
      return res.status(400).json({ error: "profileImg file is required" });
    }

    // 2️⃣ Check if wishlist exists
    const wishlistResult = await connection.query(
      "SELECT * FROM wishlist WHERE id = $1",
      [wishlistId]
    );

    if (wishlistResult.rowCount === 0) {
      return res.status(404).json({ error: "Wishlist does not exist" });
    }

    const firstName = wishlistResult.rows[0].first_name.toLowerCase(); 
    if (!firstName) {
      return res.status(400).json({ error: "first_name is required" });
    }

    // 3️⃣ Resize image
    const buffer = await sharp(req.file.buffer)
      .resize({ height: 300, width: 300, fit: "contain" })
      .toBuffer();

    // Prepare S3 upload key
    const key = `${firstName}-${wishlistId}`;

    // 4️⃣ S3 Upload
    const params = {
      Bucket: process.env.BUCKET_NAME,
      Key: key,
      Body: buffer,
      ContentType: req.file.mimetype
    };

    const command = new PutObjectCommand(params);

    await s3.send(command);

    // 5️⃣ Update wishlist image field with S3 key
    const updateResult = await connection.query(
      `UPDATE wishlist
       SET image = $1
       WHERE id = $2
       RETURNING *`,
      [key, wishlistId]
    );

    result = updateResult.rows[0];
    result.image = await getImageUrl(updateResult.rows[0].image);

    // 6️⃣ Respond success
    return res.status(200).json({
      message: "Image uploaded successfully",
      wishlist: result
    });

  } catch (err) {
    console.error("Upload error:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
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
      wishlist: {
        ...wishlistResult.rows[0],
        image: await getImageUrl(wishlistResult.rows[0].image)
      },
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

    // // 3️⃣ Attach collections to the wishlist object
    // wishlist.collections = collectionsResult.rows;

    const collections = collectionsResult.rows;

    // 3️⃣ For each collection, get its products
    for (const collection of collections) {
      const productsResult = await connection.query(
        "SELECT * FROM collectionitem_product WHERE collectionitem_id = $1",
        [collection.id]
      );

      collection.products = productsResult.rows;
      collection.no_of_items = productsResult.rows.length;
    }

    // 5️⃣ Attach collections to wishlist
    wishlist.collections = collections;
    wishlist.image = await getImageUrl(wishlist.image);

    res.status(200).json({ wishlist });

  } catch (error) {
    console.error("Error fetching collections:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET COLLECTION BY ID
// app.get("/api/collection/:collectionId", async (req, res) => {
//   const { collectionId } = req.params;

//   try {
//     const result = await connection.query(`
//       SELECT 
//           c.*,
//           to_jsonb(da) AS delivery_address,
//           COALESCE(
//             json_agg(DISTINCT jsonb_build_object(
//               'id', p.id,
//               'product_id', p.product_id,
//               'product_handle', p.product_handle,
//               'title', p.title,
//               'description', p.description,
//               'price', p.price,
//               'image_url', p.image_url,
//               'gifted', p.gifted,
//               'quantity', p.quantity,
//               'variant_id', p.variant_id
//             )) FILTER (WHERE p.id IS NOT NULL), '[]'
//           ) AS products
//       FROM collectionitem c
//       LEFT JOIN collectionitem_deliveryaddress da ON da.collectionitem_id = c.id
//       LEFT JOIN collectionitem_product p ON p.collectionitem_id = c.id
//       WHERE c.id = $1
//       GROUP BY c.id, da.id
//     `, [collectionId]);

//     if (result.rowCount === 0) {
//       return res.status(404).json({ error: "Collection item not found" });
//     }

//     res.json({ collection: result.rows[0] });

//   } catch (err) {
//     console.error(err);
//     res.status(500).json({ error: "Internal server error" });
//   }
// });

app.get("/api/collection/:collectionId", async (req, res) => {
  const { collectionId } = req.params;

  try {
    const result = await connection.query(`
      SELECT 
        c.*,

        -- DELIVERY ADDRESS stays nested inside collection
        to_jsonb(da) AS delivery_address,

        -- PRODUCTS stay nested inside collection
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
        ) AS products,

        -- WISHLIST (put outside collection later)
        to_jsonb(w) AS wishlist

      FROM collectionitem c
      LEFT JOIN collectionitem_deliveryaddress da 
        ON da.collectionitem_id = c.id
      
      LEFT JOIN collectionitem_product p 
        ON p.collectionitem_id = c.id

      LEFT JOIN wishlist w
        ON w.id = c.wishlist_id

      WHERE c.id = $1
      GROUP BY c.id, da.id, w.id
    `, [collectionId]);

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Collection item not found" });
    }

    const row = result.rows[0];

    // Extract wishlist separately
    const wishlist = row.wishlist;
    delete row.wishlist; // remove it from the collection object

    res.json({
      collection: row,
      wishlist: wishlist || null
    });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET COLLECTION BY SHARE ID
app.get("/api/share/:shareId", async (req, res) => {
  const { shareId } = req.params;

  try {
    const result = await connection.query(`
      SELECT 
          -- Collection data excluding no_of_views and wishlist_id
          (to_jsonb(c) - 'no_of_views' - 'wishlist_id') AS collection,

          -- Delivery address
          to_jsonb(da) AS delivery_address,

          -- Products (without gifted)
          COALESCE(
            json_agg(DISTINCT jsonb_build_object(
              'id', p.id,
              'product_id', p.product_id,
              'product_handle', p.product_handle,
              'title', p.title,
              'description', p.description,
              'price', p.price,
              'image_url', p.image_url,
              'quantity', p.quantity,
              'variant_id', p.variant_id
            )) FILTER (WHERE p.id IS NOT NULL), '[]'
          ) AS products,

          -- Wishlist info (first_name, last_name, image)
          jsonb_build_object(
            'first_name', w.first_name,
            'last_name', w.last_name,
            'image', w.image
          ) AS wishlist

      FROM collectionitem c
      LEFT JOIN collectionitem_deliveryaddress da ON da.collectionitem_id = c.id
      LEFT JOIN collectionitem_product p ON p.collectionitem_id = c.id
      LEFT JOIN wishlist w ON w.id = c.wishlist_id
      WHERE c.share_id = $1
        AND c.public = TRUE
        AND (c.expiry_date IS NULL OR c.expiry_date >= NOW())
      GROUP BY c.id, da.id, w.first_name, w.last_name, w.image
    `, [shareId]);

    if (result.rowCount === 0) {
      return res.status(404).json({
        error: "Collection item not found or link expired/unavailable",
      });
    }

    const row = result.rows[0];
    res.json({
      collection: {
        ...row.collection,
        delivery_address: row.delivery_address,
        products: row.products
      },
      wishlist: {
        ...row.wishlist,
        image: await getImageUrl(row.wishlist.image)
      }
    });

  } catch (err) {
    console.error("Error fetching collection by share_id:", err);
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

// UPDATE PRODUCT VARIANT IN COLLECTION
app.put("/api/collection/:collectionId/product/:productId/variant", async (req, res) => {
  const { collectionId, productId } = req.params;
  const { wishlist_id, variant_id } = req.body;

  try {
    // 1️⃣ Check if collectionitem exists AND belongs to the provided wishlist_id
    const collectionCheck = await connection.query(
      `SELECT id FROM collectionitem
       WHERE id = $1 AND wishlist_id = $2`,
      [collectionId, wishlist_id]
    );

    if (collectionCheck.rowCount === 0) {
      return res.status(404).json({ error: "Collection not found for the provided wishlist" });
    }

    // 2️⃣ Check if product exists in the collection
    const productCheck = await connection.query(
      `SELECT id FROM collectionitem_product
       WHERE collectionitem_id = $1 AND product_id = $2`,
      [collectionId, productId]
    );

    if (productCheck.rowCount === 0) {
      return res.status(404).json({ error: "Product not found in this collection" });
    }

    // 3️⃣ Update the variant_id
    const updateResult = await connection.query(
      `UPDATE collectionitem_product
       SET variant_id = $1
       WHERE collectionitem_id = $2 AND product_id = $3
       RETURNING *`,
      [variant_id, collectionId, productId]
    );

    res.status(200).json({
      message: "Product variant updated successfully",
      product: updateResult.rows[0]
    });

  } catch (err) {
    console.error("Error updating product variant:", err);
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
// app.put("/api/collection/:collectionId", async (req, res) => {
//   const { collectionId } = req.params;
//   const { wishlist_id, delivery_address, ...bodyFields } = req.body;

//   try {
//     // 1️⃣ Confirm collectionitem belongs to the wishlist
//     const collectionCheck = await connection.query(
//       `SELECT id, share_id FROM collectionitem WHERE id = $1 AND wishlist_id = $2`,
//       [collectionId, wishlist_id]
//     );

//     if (collectionCheck.rowCount === 0) {
//       return res.status(404).json({
//         error: "Collection item not found for the provided wishlist",
//       });
//     }

//     // 2️⃣ Generate share_id if not present
//     let share_id = collectionCheck.rows[0].share_id;
//     if (!share_id) {
//       const randomId =
//         Math.random().toString(36).substring(2, 19) +
//         Math.random().toString(36).substring(2, 4);
//       share_id = `share_${randomId.toUpperCase()}`;
//       bodyFields.share_id = share_id; // 👈 add to the same update
//     }

//     // 3️⃣ Dynamically build UPDATE query for collectionitem
//     const keys = Object.keys(bodyFields);
//     const values = Object.values(bodyFields);

//     if (keys.length > 0) {
//       const setQuery = keys.map((key, index) => `${key} = $${index + 1}`).join(", ");
//       await connection.query(
//         `UPDATE collectionitem
//          SET ${setQuery}, updated_at = NOW()
//          WHERE id = $${keys.length + 1}`,
//         [...values, collectionId]
//       );
//     }

//     // 4️⃣ Upsert delivery address if provided
//     let updatedAddress = null;
//     if (delivery_address) {
//       const { apartment, country, postcode, city, state, address, phone } = delivery_address;

//       const addressResult = await connection.query(
//         `INSERT INTO collectionitem_deliveryaddress
//           (collectionitem_id, apartment, country, postcode, city, state, address, phone)
//          VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
//          ON CONFLICT (collectionitem_id)
//          DO UPDATE SET
//            apartment = EXCLUDED.apartment,
//            country = EXCLUDED.country,
//            postcode = EXCLUDED.postcode,
//            city = EXCLUDED.city,
//            state = EXCLUDED.state,
//            address = EXCLUDED.address,
//            phone = EXCLUDED.phone
//          RETURNING *`,
//         [collectionId, apartment, country, postcode, city, state, address, phone]
//       );

//       updatedAddress = addressResult.rows[0];
//     }

//     // 5️⃣ Fetch updated collectionitem
//     const collectionResult = await connection.query(
//       `SELECT * FROM collectionitem WHERE id = $1`,
//       [collectionId]
//     );

//     res.json({
//       message: "Collection updated successfully",
//       collection: {
//         ...collectionResult.rows[0],
//         share_id,
//         delivery_address: updatedAddress,
//       },
//     });
//   } catch (err) {
//     console.error("Error updating collection:", err);
//     res.status(500).json({ error: "Internal server error" });
//   }
// });

app.put("/api/collection/:collectionId", async (req, res) => {
  const { collectionId } = req.params;
  const { wishlist_id, delivery_address, ...bodyFields } = req.body;

  try {
    // 1️⃣ Confirm collection belongs to wishlist
    const collectionCheck = await connection.query(
      `SELECT id, share_id 
       FROM collectionitem 
       WHERE id = $1 AND wishlist_id = $2`,
      [collectionId, wishlist_id]
    );

    if (collectionCheck.rowCount === 0) {
      return res.status(404).json({
        error: "Collection item not found for the provided wishlist",
      });
    }

    // 2️⃣ Generate share_id if missing
    let share_id = collectionCheck.rows[0].share_id;
    if (!share_id) {
      const randomId =
        Math.random().toString(36).substring(2, 19) +
        Math.random().toString(36).substring(2, 4);

      share_id = `share_${randomId.toUpperCase()}`;
      bodyFields.share_id = share_id;
    }

    // 3️⃣ Dynamic UPDATE for collectionitem
    const keys = Object.keys(bodyFields);
    const values = Object.values(bodyFields);

    if (keys.length > 0) {
      const setQuery = keys.map((key, i) => `${key} = $${i + 1}`).join(", ");
      await connection.query(
        `UPDATE collectionitem
         SET ${setQuery}, updated_at = NOW()
         WHERE id = $${keys.length + 1}`,
        [...values, collectionId]
      );
    }

    // 4️⃣ UPSERT delivery address
    let updatedAddress = null;
    if (delivery_address) {
      const { apartment, country, postcode, city, state, address, phone } =
        delivery_address;

      const addressResult = await connection.query(
        `INSERT INTO collectionitem_deliveryaddress
          (collectionitem_id, apartment, country, postcode, city, state, address, phone)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
         ON CONFLICT (collectionitem_id)
         DO UPDATE SET
           apartment = EXCLUDED.apartment,
           country = EXCLUDED.country,
           postcode = EXCLUDED.postcode,
           city = EXCLUDED.city,
           state = EXCLUDED.state,
           address = EXCLUDED.address,
           phone = EXCLUDED.phone
         RETURNING *`,
        [collectionId, apartment, country, postcode, city, state, address, phone]
      );

      updatedAddress = addressResult.rows[0];
    }

    // 5️⃣ Fetch updated collectionitem
    const collectionResult = await connection.query(
      `SELECT * FROM collectionitem WHERE id = $1`,
      [collectionId]
    );

    // 6️⃣ Fetch wishlist
    const wishlistResult = await connection.query(
      `SELECT * FROM wishlist WHERE id = $1`,
      [wishlist_id]
    );

    const wishlist = wishlistResult.rowCount > 0 ? wishlistResult.rows[0] : null;

    // 7️⃣ Final response with wishlist included
    res.json({
      message: "Collection updated successfully",
      collection: {
        ...collectionResult.rows[0],
        share_id,
        delivery_address: updatedAddress,
      },
      wishlist,
    });

  } catch (err) {
    console.error("Error updating collection:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});


// ASHLUXURY BACKEND SERVER.JS

// ADD COLLECTION
app.post("/api/ashluxury/wishlist/:wishlistId/collection", async (req, res) => {
  const { wishlistId } = req.params;
  const { title, first_name, last_name, image } = req.body;

  if (!title) {
    return res.status(400).json({ error: "Collection title is required" });
  }

  try {
    // 1️⃣ Check if wishlist exists
    let wishlistResult = await connection.query(
      "SELECT id, first_name, last_name, image FROM ashluxury_wishlist WHERE id = $1",
      [wishlistId]
    );

    // 2️⃣ If wishlist doesn't exist, create it
    if (wishlistResult.rowCount === 0) {
      if (!first_name || !last_name) {
        return res.status(400).json({ error: "first_name and last_name are required to create a new wishlist" });
      }

      const createWishlistResult = await connection.query(
        `INSERT INTO ashluxury_wishlist (id, first_name, last_name, image)
         VALUES ($1, $2, $3, $4)
         RETURNING *`,
        [wishlistId, first_name, last_name, image || null]
      );

      wishlistResult = createWishlistResult;
    }

    // 3️⃣ Insert new collection item linked to this wishlist
    const insertResult = await connection.query(
      `INSERT INTO ashluxury_collectionitem (title, wishlist_id)
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
app.get("/api/ashluxury/wishlist/:wishlistId", async (req, res) => {
  const { wishlistId } = req.params;

  try {
    // 1️⃣ Check if wishlist exists
    const wishlistResult = await connection.query(
      "SELECT * FROM ashluxury_wishlist WHERE id = $1",
      [wishlistId]
    );

    if (wishlistResult.rowCount === 0) {
      return res.status(404).json({ error: "Wishlist not found" });
    }

    const wishlist = wishlistResult.rows[0];

    // 2️⃣ Get all collection items linked to this wishlist
    const collectionsResult = await connection.query(
      "SELECT * FROM ashluxury_collectionitem WHERE wishlist_id = $1 ORDER BY created_at DESC",
      [wishlistId]
    );

    // // 3️⃣ Attach collections to the wishlist object
    // wishlist.collections = collectionsResult.rows;



    const collections = collectionsResult.rows;

    // 3️⃣ For each collection, get its products
    for (const collection of collections) {
      const productsResult = await connection.query(
        "SELECT * FROM ashluxury_collectionitem_product WHERE collectionitem_id = $1",
        [collection.id]
      );

      collection.products = productsResult.rows;
      collection.no_of_items = productsResult.rows.length;
    }

    // 5️⃣ Attach collections to wishlist
    wishlist.collections = collections;

    res.status(200).json({ wishlist });

  } catch (error) {
    console.error("Error fetching collections:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET COLLECTION BY ID
app.get("/api/ashluxury/collection/:collectionId", async (req, res) => {
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
      FROM ashluxury_collectionitem c
      LEFT JOIN ashluxury_collectionitem_deliveryaddress da ON da.collectionitem_id = c.id
      LEFT JOIN ashluxury_collectionitem_product p ON p.collectionitem_id = c.id
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

// GET COLLECTION BY SHARE ID
app.get("/api/ashluxury/share/:shareId", async (req, res) => {
  const { shareId } = req.params;

  try {
    const result = await connection.query(`
      SELECT 
          -- Collection data excluding no_of_views and wishlist_id
          (to_jsonb(c) - 'no_of_views' - 'wishlist_id') AS collection,

          -- Delivery address
          to_jsonb(da) AS delivery_address,

          -- Products (without gifted)
          COALESCE(
            json_agg(DISTINCT jsonb_build_object(
              'id', p.id,
              'product_id', p.product_id,
              'product_handle', p.product_handle,
              'title', p.title,
              'description', p.description,
              'price', p.price,
              'image_url', p.image_url,
              'quantity', p.quantity,
              'variant_id', p.variant_id
            )) FILTER (WHERE p.id IS NOT NULL), '[]'
          ) AS products,

          -- Wishlist info (first_name, last_name, image)
          jsonb_build_object(
            'first_name', w.first_name,
            'last_name', w.last_name,
            'image', w.image
          ) AS wishlist

      FROM ashluxury_collectionitem c
      LEFT JOIN ashluxury_collectionitem_deliveryaddress da ON da.collectionitem_id = c.id
      LEFT JOIN ashluxury_collectionitem_product p ON p.collectionitem_id = c.id
      LEFT JOIN ashluxury_wishlist w ON w.id = c.wishlist_id
      WHERE c.share_id = $1
        AND c.public = TRUE
        AND (c.expiry_date IS NULL OR c.expiry_date >= NOW())
      GROUP BY c.id, da.id, w.first_name, w.last_name, w.image
    `, [shareId]);

    if (result.rowCount === 0) {
      return res.status(404).json({
        error: "Collection item not found or link expired/unavailable",
      });
    }

    const row = result.rows[0];
    res.json({
      collection: {
        ...row.collection,
        delivery_address: row.delivery_address,
        products: row.products
      },
      wishlist: row.wishlist
    });

  } catch (err) {
    console.error("Error fetching collection by share_id:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// ADD PRODUCT TO COLLECTION
app.post("/api/ashluxury/collection/:collectionId/product", async (req, res) => {
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
      `SELECT id FROM ashluxury_collectionitem
       WHERE id = $1 AND wishlist_id = $2`,
      [collectionId, wishlist_id]
    );

    if (collectionCheck.rowCount === 0) {
      return res.status(404).json({ error: "Collection item not found for the provided wishlist" });
    }

    // 2️⃣ Check if product already exists in the collectionitem
    const duplicateCheck = await connection.query(
      `SELECT id FROM ashluxury_collectionitem_product
       WHERE collectionitem_id = $1 AND product_id = $2`,
      [collectionId, product_id]
    );

    if (duplicateCheck.rowCount > 0) {
      return res.status(400).json({ error: "Product already exists in this collection" });
    }

    // 3️⃣ Insert product into collectionitem_product
    const insertResult = await connection.query(
      `INSERT INTO ashluxury_collectionitem_product
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

// UPDATE PRODUCT VARIANT IN COLLECTION
app.put("/api/ashluxury/collection/:collectionId/product/:productId/variant", async (req, res) => {
  const { collectionId, productId } = req.params;
  const { wishlist_id, variant_id } = req.body;

  try {
    // 1️⃣ Check if collectionitem exists AND belongs to the provided wishlist_id
    const collectionCheck = await connection.query(
      `SELECT id FROM ashluxury_collectionitem
       WHERE id = $1 AND wishlist_id = $2`,
      [collectionId, wishlist_id]
    );

    if (collectionCheck.rowCount === 0) {
      return res.status(404).json({ error: "Collection not found for the provided wishlist" });
    }

    // 2️⃣ Check if product exists in the collection
    const productCheck = await connection.query(
      `SELECT id FROM ashluxury_collectionitem_product
       WHERE collectionitem_id = $1 AND product_id = $2`,
      [collectionId, productId]
    );

    if (productCheck.rowCount === 0) {
      return res.status(404).json({ error: "Product not found in this collection" });
    }

    // 3️⃣ Update the variant_id
    const updateResult = await connection.query(
      `UPDATE ashluxury_collectionitem_product
       SET variant_id = $1
       WHERE collectionitem_id = $2 AND product_id = $3
       RETURNING *`,
      [variant_id, collectionId, productId]
    );

    res.status(200).json({
      message: "Product variant updated successfully",
      product: updateResult.rows[0]
    });

  } catch (err) {
    console.error("Error updating product variant:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// DELETE PRODUCT FROM COLLECTION
app.delete("/api/ashluxury/collection/:collectionId/product/:productId", async (req, res) => {
  const { collectionId, productId } = req.params;
  const { wishlist_id } = req.body; // Pass wishlist_id in body

  try {
    // 1️⃣ Confirm collectionitem belongs to the wishlist
    const collectionCheck = await connection.query(
      `SELECT id FROM ashluxury_collectionitem
       WHERE id = $1 AND wishlist_id = $2`,
      [collectionId, wishlist_id]
    );

    if (collectionCheck.rowCount === 0) {
      return res.status(404).json({ error: "Collection item not found for the provided wishlist" });
    }

    // 2️⃣ Delete product from collectionitem_product
    const deleteResult = await connection.query(
      `DELETE FROM ashluxury_collectionitem_product
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
app.put("/api/ashluxury/collection/:collectionId", async (req, res) => {
  const { collectionId } = req.params;
  const { wishlist_id, delivery_address, ...bodyFields } = req.body;

  try {
    // 1️⃣ Confirm collectionitem belongs to the wishlist
    const collectionCheck = await connection.query(
      `SELECT id, share_id FROM ashluxury_collectionitem WHERE id = $1 AND wishlist_id = $2`,
      [collectionId, wishlist_id]
    );

    if (collectionCheck.rowCount === 0) {
      return res.status(404).json({ error: "Collection item not found for the provided wishlist" });
    }

    // 2️⃣ Generate share_id if not present
    let share_id = collectionCheck.rows[0].share_id;
    if (!share_id) {
      const randomId =
        Math.random().toString(36).substring(2, 19) +
        Math.random().toString(36).substring(2, 4);
      share_id = `share_${randomId.toUpperCase()}`;
      bodyFields.share_id = share_id; // 👈 add to the same update
    }

    // 2️⃣ Dynamically build UPDATE query for collectionitem
    const keys = Object.keys(bodyFields); // fields to update
    const values = Object.values(bodyFields);

    if (keys.length > 0) {
      const setQuery = keys.map((key, index) => `${key} = $${index + 1}`).join(", ");
      await connection.query(
        `UPDATE ashluxury_collectionitem
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
        `INSERT INTO ashluxury_collectionitem_deliveryaddress
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
      `SELECT * FROM ashluxury_collectionitem_product WHERE collectionitem_id = $1`,
      [collectionId]
    );

    // 5️⃣ Fetch updated collectionitem
    const collectionResult = await connection.query(
      `SELECT * FROM ashluxury_collectionitem WHERE id = $1`,
      [collectionId]
    );

    res.json({
      message: "Collection updated successfully",
      collection: {
        ...collectionResult.rows[0],
        share_id,
        delivery_address: updatedAddress
      }
    });
  } catch (err) {
    console.error("Error updating collection:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});



// const httpsOptions = {
//     key: fs.readFileSync('/home/ec2-user/ashluxe-backend/server.key'),
//     cert: fs.readFileSync('/home/ec2-user/ashluxe-backend/server.crt')
// };

// https.createServer(httpsOptions, app).listen(port, () => {
//     console.log(`HTTPS Server is running on port ${port}`);
// });

app.listen(port, () => {
    console.log(`Server is running on port ${port}`);
});