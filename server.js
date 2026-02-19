

import { Client } from "pg";
import { S3Client, PutObjectCommand, GetObjectCommand } from "@aws-sdk/client-s3";
import { getSignedUrl } from "@aws-sdk/s3-request-presigner";
import express from "express";
import path from "path";
import cors from "cors";
import multer from "multer";
import sharp from "sharp";
import bootstrap from "./config/bootstrap.js";
import dotenv from "dotenv";
import { getSecrets } from './config/secrets.js';
// import errorHandler from "./middleware/errorHandler.js";

// load env vars
dotenv.config();


const app = express();

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
  if (imageName === null) return null;

  // If you want to return a public URL instead of a signed URL, uncomment below:
  const url = `https://${process.env.BUCKET_NAME}.s3.${process.env.BUCKET_REGION}.amazonaws.com/${imageName}`;
  return url;
  // const getObjectParams = {
  //   Bucket: process.env.BUCKET_NAME,
  //   Key: imageName
  // };
  // const getCommand = new GetObjectCommand(getObjectParams);
  // const url = await getSignedUrl(s3, getCommand, { expiresIn: 3600 });
  // return url;
}

async function getWishlistDataFromDB(store) {
  try {
    const wishlsitOrderResults = await connection.query(
      "SELECT order_id FROM wishlist_orders"
    );
    const orderIds = wishlsitOrderResults.rows.map(row => (row.order_id));

    const secrets = getSecrets();
    let endpoint = secrets.SHOPIFY_STORE_URL;
    let ADMIN_ACCESS_TOKEN = secrets.SHOPIFY_ADMIN_ACCESS_TOKEN ;

    if (store === 'ashluxury') {
      endpoint = secrets.SHOPIFY_STORE_URL_ASHLUXURY;
      ADMIN_ACCESS_TOKEN = secrets.SHOPIFY_ADMIN_ACCESS_TOKEN_ASHLUXURY;
    }

    // const orderIds = [5858563227699, 5858632302643, 5858633285683];
    const gids = orderIds.map(id => `gid://shopify/Order/${id}`);

    const query = `
      query getOrdersByIds($ids: [ID!]!) {
        nodes(ids: $ids) {
          ... on Order {
            id
            confirmationNumber
            currencyCode
            email
            displayFinancialStatus
            displayFulfillmentStatus
            name
            createdAt

            customAttributes {
              key
              value
            }

            totalPriceSet {
              shopMoney {
                amount
                currencyCode
              }
            }

            customer {
              id
              firstName
              lastName
              email
            }

            lineItems(first: 50) {
              edges {
                node {
                  id
                  title
                  quantity
                  sku
                  originalUnitPriceSet {
                    shopMoney {
                      amount
                      currencyCode
                    }
                  }
                }
              }
            }
          }
        }
      }
    `;

    const response = await fetch(endpoint, {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "X-Shopify-Access-Token": ADMIN_ACCESS_TOKEN
        },
        body: JSON.stringify({
          query,
          variables: { ids: gids }
        })
      }
    );

    const result = await response.json();

    if (!result.data || !result.data.nodes) {
      console.error("Shopify GraphQL error:", result.errors);
      return res.status(400).json({ error: "Failed to fetch Shopify orders", details: result.errors });
    }

    const orders = result.data.nodes.filter(Boolean);

    // Map Shopify response into your dashboard format
    const formattedOrders = orders.map(order => {
      // Get wishlist_share_id from customAttributes
      const wishlistAttr = order.customAttributes?.find(attr => attr.key === "wishlistShareId")?.value || "";

      // Count line items
      const itemsCount = order.lineItems?.edges?.reduce(
        (acc, edge) => acc + (edge.node.quantity || 0),
        0
      ) || 0;

      return {
        orderId: order.name || order.id,
        wishlistShareId: wishlistAttr,
        // dateCreated: order.createdAt ? order.createdAt.split("T")[0] : "",
        dateCreated: formatOrderDate(order.createdAt) || "",
        customerName: order.customer ? `${order.customer.firstName} ${order.customer.lastName}` : "",
        channel: "Online store",
        amount: `${order.totalPriceSet?.shopMoney?.amount} ${order.totalPriceSet?.shopMoney?.currencyCode}` || "0.00",
        paymentStatus: order.displayFinancialStatus?.toLowerCase() || "",
        fulfillmentStatus: order.displayFulfillmentStatus?.toLowerCase() || "",
        items: itemsCount === 1 ? "1 item" : `${itemsCount} items`, // ✅ formatted
        deliveryStatus: "", // You can fill from fulfillment data if needed
        deliveryMethod: ""  // Optional
      };
    });
    
    return formattedOrders;
  } catch (error) {
    console.log('AN ERROR - ', error)
    return [];
  }
}

function formatOrderDate(isoDate) {
  if (!isoDate) return "";

  const orderDate = new Date(isoDate);
  const now = new Date();

  const orderDay = orderDate.toDateString();
  const today = now.toDateString();

  // Yesterday
  const yesterday = new Date();
  yesterday.setDate(now.getDate() - 1);

  let dayLabel = "";

  if (orderDay === today) {
    dayLabel = "Today";
  } else if (orderDay === yesterday.toDateString()) {
    dayLabel = "Yesterday";
  } else {
    // Wednesday, Monday, etc
    dayLabel = orderDate.toLocaleDateString("en-US", { weekday: "long" });
  }

  // format time as HH:MM (24hr)
  const time = orderDate.toLocaleTimeString([], {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false
  });

  return `${dayLabel} at ${time}`;
}

// app.get('/', (req, res) => {
//   res.send('ASHLUXE WISHLIST API is running....');
// });
(async () => {
  try {
    await bootstrap();

app.set('view engine', 'ejs');
app.set('views', path.join(process.cwd(), 'views'));

app.use(express.urlencoded({ extended: true }));
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

app.get('/', async (req, res) => {
  const { search, paymentStatus, fulfillmentStatus } = req.query;

  let tableData = await getWishlistDataFromDB(); // your DB function
  let dashboardData = await getDashboardData();

  if (search && search.trim() !== "") {
    const term = search.toLowerCase();

    tableData = tableData.filter(item =>
      item.customerName.toLowerCase().includes(term) ||
      item.wishlistShareId.toLowerCase().includes(term) ||
      item.orderId.toLowerCase().includes(term)
    );
  }

  // Filter by payment status
  if (paymentStatus && paymentStatus !== "") {
    tableData = tableData.filter(item =>
      item.paymentStatus.toLowerCase() === paymentStatus.toLowerCase()
    );
  }

  // Filter by fulfillment status
  if (fulfillmentStatus && fulfillmentStatus !== "") {
    tableData = tableData.filter(item =>
      item.fulfillmentStatus.toLowerCase() === fulfillmentStatus.toLowerCase()
    );
  }

  res.render('dashboard', {
    stats: dashboardData,
    orders: tableData,
    currentRoute: req.path,
    search,
    paymentStatus,
    fulfillmentStatus
  });
});

app.post('/shopify_order_create', async (req, res) => {
    const order = req.body;
    const orderId = order?.id;
    const lineItems = order?.line_items || [];
    const wishlistShareId = order?.note_attributes?.find(
      attr => attr.name === "wishlistShareId"
    )?.value;

    if (!orderId || !wishlistShareId) {
      return;
    }

    // Insert into wishlist_orders DB
    const orders = await connection.query(
      `INSERT INTO wishlist_orders (order_id, wishlist_share_id)
       VALUES ($1, $2)
       ON CONFLICT (order_id) DO NOTHING`,
      [orderId, wishlistShareId]
    );
    if (orders.rowCount === 0) {
      return;
    }

    // UPDATE GIFTED column in collectionitem_product
    // Get collectionitem id for this share_id
    const prefixedShareId = `share_${wishlistShareId}`;
    const { rows } = await connection.query(
      `SELECT id FROM collectionitem WHERE share_id = $1`,
      [prefixedShareId]
    );
    if (!rows.length) return;
    const collectionItemId = rows[0].id;
    
    // Loop through order line items
    for (const item of lineItems) {
      const productId = item.product_id;
      const quantity = item.quantity || 1;

      if (!productId) continue;

      // 3. Update gifted count if product exists
      await connection.query(
        `UPDATE collectionitem_product
         SET gifted = gifted + $3
         WHERE collectionitem_id = $1
         AND product_id = $2`,
        [collectionItemId, productId, quantity]
      );
    }
});

app.post('/shopify_cart_update', async (req, res) => {
  try {
    const webhookId = req.headers['x-shopify-webhook-id'];
    const order = req.body;
    const orderId = order.id;
    const note = order.note || "";
    const match = note.match(/wishlistShareId=([^\s]+)/);
    const wishlistShareId = match ? match[1] : null;
    const lineItems = order?.line_items || [];
    const productIds = lineItems
      .map(i => i.product_id)
      .filter(Boolean);

    if (!productIds.length) return;

    if (!wishlistShareId || !webhookId || !orderId) return;

    console.log('THE WISHLIST - ', wishlistShareId, orderId)

    // 1. Check if webhook already processed
    // const { rows: existingWebhook } = await connection.query(
    //   `SELECT 1 FROM processed_webhooks WHERE webhook_id = $1`,
    //   [webhookId]
    // );
    const { rows: existingWebhook } = await connection.query(
      `SELECT line_items FROM processed_webhooks WHERE order_id = $1`,
      [orderId]
    );

    let existingProductIds = [];

    if (existingWebhook.length > 0) {
      existingProductIds = existing[0].line_items || [];
    }

    // find NEW product ids only
    const newProductIds = productIds.filter(
      pid => !existingProductIds.includes(pid)
    );

    // if no new products, return
    if (newProductIds.length === 0) {
      console.log("Duplicate webhook ignored:", orderId);
      return;
    }

    // UPDATE CARTED column in collectionitem_product
    // Get collectionitem id for this share_id
    const { rows: collectionRows } = await connection.query(
      `SELECT id FROM collectionitem WHERE share_id = $1`,
      [wishlistShareId]
    );
    if (!collectionRows.length) return;
    const collectionItemId = collectionRows[0].id;
    // Loop through order line items
    for (const item of lineItems) {
      const productId = item.product_id;
      const quantity = 1;

      if (!newProductIds.includes(productId)) continue;

      // 3. Update carted count if product exists
      await connection.query(
        `UPDATE collectionitem_product
         SET carted = carted + $3
         WHERE collectionitem_id = $1
         AND product_id = $2`,
        [collectionItemId, productId, quantity]
      );
    }

    // Now update processed_webhooks table
    if (existingWebhook.length === 0) {
      // first time order seen
      await connection.query(
        `INSERT INTO processed_webhooks (webhook_id, order_id, line_items)
        VALUES ($1, $2, $3)`,
        [webhookId, orderId, JSON.stringify(productIds)]
      );
    } else {
      // append new product ids
      const updatedProductIds = [...existingProductIds, ...newProductIds];

      await connection.query(
        `UPDATE processed_webhooks
        SET line_items = $2
        WHERE order_id = $1`,
        [orderId, JSON.stringify(updatedProductIds)]
      );
    }
    
    console.log('Webhook finished processing')
    res.status(200).send("OK");
  } catch (error) {
    console.error("Webhook processing failed:", err);
  }
});

app.get('/ashluxury', async (req, res) => {
  const { search, paymentStatus, fulfillmentStatus } = req.query;

  let tableData = await getWishlistDataFromDB('ashluxury'); // your DB function
  let dashboardData = await getDashboardData('ashluxury');

  if (search && search.trim() !== "") {
    const term = search.toLowerCase();

    tableData = tableData.filter(item =>
      item.customerName.toLowerCase().includes(term) ||
      item.wishlistShareId.toLowerCase().includes(term) ||
      item.orderId.toLowerCase().includes(term)
    );
  }

  // Filter by payment status
  if (paymentStatus && paymentStatus !== "") {
    tableData = tableData.filter(item =>
      item.paymentStatus.toLowerCase() === paymentStatus.toLowerCase()
    );
  }

  // Filter by fulfillment status
  if (fulfillmentStatus && fulfillmentStatus !== "") {
    tableData = tableData.filter(item =>
      item.fulfillmentStatus.toLowerCase() === fulfillmentStatus.toLowerCase()
    );
  }

  res.render('dashboard', {
    stats: dashboardData,
    orders: tableData,
    currentRoute: req.path,
    search,
    paymentStatus,
    fulfillmentStatus
  });
});

app.post('/shopify_order_create_ashluxury', async (req, res) => {
    const order = req.body;
    const orderId = order?.id;
    const wishlistShareId = order?.note_attributes?.find(
      attr => attr.name === "wishlistShareId"
    )?.value;

    if (!orderId || !wishlistShareId) {
      return;
    }

    // Insert into DB
    await connection.query(
      `INSERT INTO ashluxury_wishlist_orders (order_id, wishlist_share_id)
       VALUES ($1, $2)
       ON CONFLICT (order_id) DO NOTHING`,
      [orderId, wishlistShareId]
    );
});

app.get('/shopify_orders', async (req, res) => {
  let data = await getWishlistDataFromDB();
  if (data === null) {
    res.status(500).json({ error: "Failed to fetch Shopify orders" });
  } else {
    res.status(200).json({ orders: data });
  }
});

async function getDashboardData(store) {
  try {
    // const secrets = getSecrets();
    // let endpoint = secrets.SHOPIFY_STORE_URL;
    // let ADMIN_ACCESS_TOKEN = secrets.SHOPIFY_ADMIN_ACCESS_TOKEN ;

    if (store === 'ashluxury') {
      // endpoint = secrets.SHOPIFY_STORE_URL_ASHLUXURY;
      // ADMIN_ACCESS_TOKEN = secrets.SHOPIFY_ADMIN_ACCESS_TOKEN_ASHLUXURY;
    }

    // COUNT WISHLIST USERS
    const wishlistUserResult = await connection.query(
      `SELECT COUNT(*) AS total FROM wishlist`
    );
    const totalWishlistUsers = parseInt(wishlistUserResult.rows[0].total) || 0;

    // COUNT WISHLIST USERS
    const wishlistProfileResult = await connection.query(
      `SELECT COUNT(*) AS total FROM collectionitem`
    );
    const totalWishlistProfiles = parseInt(wishlistProfileResult.rows[0].total) || 0;

    // COUNT WISHLIST USERS
    const wishlistProductResult = await connection.query(
      `SELECT COUNT(*) AS total FROM collectionitem_product`
    );
    const totalWishlistProducts = parseInt(wishlistProductResult.rows[0].total) || 0;

    const wishlistCount = await connection.query(
      `SELECT 
        COUNT(*) FILTER (WHERE gifted >= 1) AS gifted_count,
        COUNT(*) FILTER (WHERE carted >= 1) AS carted_count
      FROM collectionitem_product`
    );
    const totalGifted = parseInt(wishlistCount.rows[0].gifted_count, 10);
    const totalCarted = parseInt(wishlistCount.rows[0].carted_count, 10);

    const totalCustomers = 49652;
    
    const dashboardData = {
      totalWishlistProfiles: totalWishlistProfiles,
      totalWishlistUsers: totalWishlistUsers,
      totalCustomers: totalCustomers,
      wishlistAdoptionRate: parseFloat((totalWishlistUsers * 100 / totalCustomers).toFixed(2)),
      wishistAdds: totalWishlistProducts,
      wishlistAddsPerUser: parseFloat((totalWishlistProducts / totalWishlistUsers).toFixed(2)),
      wishlistReturningUsers: '',
      wishlistFeatureEngagementRate: '',
      wishlistToCart: parseFloat((totalCarted * 100 / totalWishlistProducts).toFixed(2)),
      wishlistToPurchase: parseFloat((totalGifted * 100 / totalWishlistProducts).toFixed(2)),
    }
    return dashboardData;
  } catch(error) {
    console.log('[Error getting dashboard data]', error)
    return null;
  }
};

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
  const { title, first_name, last_name, image,

    // optional product fields
    product_id,
    product_handle,
    description,
    price,
    image_url,
    gifted = 0,
    quantity = 1,
    variant_id } = req.body;

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

    const collection = insertResult.rows[0];

    let product = null;

    // 4️⃣ OPTIONAL: Add product if product_id exists
    if (product_id) {
      const productInsert = await connection.query(
        `INSERT INTO collectionitem_product
          (collectionitem_id, product_id, product_handle, title, description,
           price, image_url, gifted, quantity, variant_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING *`,
        [
          collection.id,
          product_id,
          product_handle,
          title,
          description,
          price,
          image_url,
          gifted,
          quantity,
          variant_id
        ]
      );

      product = productInsert.rows[0];
    }

    res.status(201).json({
      message: product
        ? "Collection created and product added"
        : "Collection created",
      wishlist: {
        ...wishlistResult.rows[0],
        image: await getImageUrl(wishlistResult.rows[0].image)
      },
      collection: insertResult.rows[0],
      products: product ? [product] : []
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
    let wishlist = row.wishlist;
    wishlist.image = await getImageUrl(wishlist.image);
    delete row.wishlist; // remove it from the collection object

    res.json({
      collection: row,
      wishlist: wishlist || []
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

    let wishlist = wishlistResult.rowCount > 0 ? wishlistResult.rows[0] : null;
    wishlist.image = await getImageUrl(wishlist.image);

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

// UPLOAD PROFILE IMG
app.post("/api/ashluxury/wishlist/:wishlistId/upload", upload.single('profileImg'), async (req, res) => {
  const { wishlistId } = req.params;

  try {
    // 1️⃣ Validate required fields
    if (!req.file) {
      return res.status(400).json({ error: "profileImg file is required" });
    }

    // 2️⃣ Check if wishlist exists
    const wishlistResult = await connection.query(
      "SELECT * FROM ashluxury_wishlist WHERE id = $1",
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
    const key = `ashluxury_${firstName}-${wishlistId}`;

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
      `UPDATE ashluxury_wishlist
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
app.post("/api/ashluxury/wishlist/:wishlistId/collection", async (req, res) => {
  const { wishlistId } = req.params;
  const { title, first_name, last_name, image,

    // optional product fields
    product_id,
    product_handle,
    description,
    price,
    image_url,
    gifted = 0,
    quantity = 1,
    variant_id } = req.body;

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

    const collection = insertResult.rows[0];

    let product = null;

    // 4️⃣ OPTIONAL: Add product if product_id exists
    if (product_id) {
      const productInsert = await connection.query(
        `INSERT INTO ashluxury_collectionitem_product
          (collectionitem_id, product_id, product_handle, title, description,
           price, image_url, gifted, quantity, variant_id)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)
         RETURNING *`,
        [
          collection.id,
          product_id,
          product_handle,
          title,
          description,
          price,
          image_url,
          gifted,
          quantity,
          variant_id
        ]
      );

      product = productInsert.rows[0];
    }

    res.status(201).json({
      message: product
        ? "Collection created and product added"
        : "Collection created",
      wishlist: {
        ...wishlistResult.rows[0],
        image: await getImageUrl(wishlistResult.rows[0].image)
      },
      collection: insertResult.rows[0],
      products: product ? [product] : []
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
    wishlist.image = await getImageUrl(wishlist.image);

    res.status(200).json({ wishlist });

  } catch (error) {
    console.error("Error fetching collections:", error);
    res.status(500).json({ error: "Internal server error" });
  }
});

// GET COLLECTION BY ID
// app.get("/api/ashluxury/collection/:collectionId", async (req, res) => {
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
//       FROM ashluxury_collectionitem c
//       LEFT JOIN ashluxury_collectionitem_deliveryaddress da ON da.collectionitem_id = c.id
//       LEFT JOIN ashluxury_collectionitem_product p ON p.collectionitem_id = c.id
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

app.get("/api/ashluxury/collection/:collectionId", async (req, res) => {
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

      FROM ashluxury_collectionitem c
      LEFT JOIN ashluxury_collectionitem_deliveryaddress da 
        ON da.collectionitem_id = c.id
      
      LEFT JOIN ashluxury_collectionitem_product p 
        ON p.collectionitem_id = c.id

      LEFT JOIN ashluxury_wishlist w
        ON w.id = c.wishlist_id

      WHERE c.id = $1
      GROUP BY c.id, da.id, w.id
    `, [collectionId]);

    if (result.rowCount === 0) {
      return res.status(404).json({ error: "Collection item not found" });
    }

    const row = result.rows[0];

    // Extract wishlist separately
    let wishlist = row.wishlist;
    wishlist.image = await getImageUrl(wishlist.image);
    delete row.wishlist; // remove it from the collection object

    res.json({
      collection: row,
      wishlist: wishlist || []
    });

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
// app.put("/api/ashluxury/collection/:collectionId", async (req, res) => {
//   const { collectionId } = req.params;
//   const { wishlist_id, delivery_address, ...bodyFields } = req.body;

//   try {
//     // 1️⃣ Confirm collectionitem belongs to the wishlist
//     const collectionCheck = await connection.query(
//       `SELECT id, share_id FROM ashluxury_collectionitem WHERE id = $1 AND wishlist_id = $2`,
//       [collectionId, wishlist_id]
//     );

//     if (collectionCheck.rowCount === 0) {
//       return res.status(404).json({ error: "Collection item not found for the provided wishlist" });
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

//     // 2️⃣ Dynamically build UPDATE query for collectionitem
//     const keys = Object.keys(bodyFields); // fields to update
//     const values = Object.values(bodyFields);

//     if (keys.length > 0) {
//       const setQuery = keys.map((key, index) => `${key} = $${index + 1}`).join(", ");
//       await connection.query(
//         `UPDATE ashluxury_collectionitem
//          SET ${setQuery}, updated_at = NOW()
//          WHERE id = $${keys.length + 1}`,
//         [...values, collectionId]
//       );
//     }

//     // 3️⃣ Upsert delivery address if provided
//     let updatedAddress = null;
//     if (delivery_address) {
//       const { house_number, apartment, country, postcode } = delivery_address;
//       const addressResult = await connection.query(
//         `INSERT INTO ashluxury_collectionitem_deliveryaddress
//           (collectionitem_id, house_number, apartment, country, postcode)
//          VALUES ($1, $2, $3, $4, $5)
//          ON CONFLICT (collectionitem_id)
//          DO UPDATE SET
//            house_number = EXCLUDED.house_number,
//            apartment = EXCLUDED.apartment,
//            country = EXCLUDED.country,
//            postcode = EXCLUDED.postcode
//          RETURNING *`,
//         [collectionId, house_number, apartment, country, postcode]
//       );
//       updatedAddress = addressResult.rows[0];
//     }

//     // 4️⃣ Fetch all products for this collectionitem
//     const productsResult = await connection.query(
//       `SELECT * FROM ashluxury_collectionitem_product WHERE collectionitem_id = $1`,
//       [collectionId]
//     );

//     // 5️⃣ Fetch updated collectionitem
//     const collectionResult = await connection.query(
//       `SELECT * FROM ashluxury_collectionitem WHERE id = $1`,
//       [collectionId]
//     );

//     res.json({
//       message: "Collection updated successfully",
//       collection: {
//         ...collectionResult.rows[0],
//         share_id,
//         delivery_address: updatedAddress
//       }
//     });
//   } catch (err) {
//     console.error("Error updating collection:", err);
//     res.status(500).json({ error: "Internal server error" });
//   }
// });

app.put("/api/ashluxury/collection/:collectionId", async (req, res) => {
  const { collectionId } = req.params;
  const { wishlist_id, delivery_address, ...bodyFields } = req.body;

  try {
    // 1️⃣ Confirm collection belongs to wishlist
    const collectionCheck = await connection.query(
      `SELECT id, share_id 
       FROM ashluxury_collectionitem 
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
        `UPDATE ashluxury_collectionitem
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
        `INSERT INTO ashluxury_collectionitem_deliveryaddress
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
      `SELECT * FROM ashluxury_collectionitem WHERE id = $1`,
      [collectionId]
    );

    // 6️⃣ Fetch wishlist
    const wishlistResult = await connection.query(
      `SELECT * FROM ashluxury_wishlist WHERE id = $1`,
      [wishlist_id]
    );

    let wishlist = wishlistResult.rowCount > 0 ? wishlistResult.rows[0] : null;
    wishlist.image = await getImageUrl(wishlist.image);

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

} catch (err) {
    console.error('Startup failed:', err);
    process.exit(1);
  }
})();