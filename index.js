require('dotenv').config();

const express = require('express');
const cors = require('cors');
const dns = require('dns');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const admin = require('firebase-admin');
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY);
const port = process.env.PORT || 3000;

dns.setServers(["1.1.1.1", "8.8.8.8"]);

// ============= FIREBASE ADMIN INITIALIZATION =============
let serviceAccount;

if (process.env.FIREBASE_SERVICE_ACCOUNT) {
  // For Render/Vercel deployment - decode from base64
  try {
    const decoded = Buffer.from(process.env.FIREBASE_SERVICE_ACCOUNT, 'base64').toString('utf-8');
    serviceAccount = JSON.parse(decoded);
    console.log('✅ Firebase loaded from environment variable');
  } catch (err) {
    console.error('❌ Failed to decode Firebase credentials:', err.message);
    throw err;
  }
} else {
  // For local development - load from file
  try {
    serviceAccount = require('./serviceAccountKey.json');
    console.log('✅ Firebase loaded from local file');
  } catch (err) {
    console.error('❌ Failed to load service account:', err.message);
    throw new Error('Service account not found!');
  }
}

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const app = express();

// ============= CORS CONFIGURATION =============
app.use(
  cors({
    origin: [
      process.env.CLIENT_DOMAIN || 'http://localhost:5173',
      'http://localhost:5173',
      'http://localhost:3000'
    ],
    credentials: true,
    optionsSuccessStatus: 200,
  })
);
app.use(express.json());

// ============= MONGODB CONNECTION (PERSISTENT) =============
const client = new MongoClient(process.env.MONGODB_URI, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
  maxPoolSize: 10,
  minPoolSize: 2,
  connectTimeoutMS: 30000,
  socketTimeoutMS: 45000,
});

let db = null;
let isConnected = false;

async function connectDB() {
  if (db && isConnected) {
    console.log('🔄 Using existing database connection');
    return db;
  }

  try {
    console.log('🆕 Establishing new MongoDB connection...');
    await client.connect();
    db = client.db('clubSphere');
    
    // Test the connection
    await client.db('admin').command({ ping: 1 });
    isConnected = true;
    console.log('✅ MongoDB connected successfully!');
    console.log(`📊 Database: ${db.databaseName}`);
    
    return db;
  } catch (error) {
    console.error('❌ MongoDB connection error:', error);
    throw error;
  }
}

// Handle connection events
client.on('error', (error) => {
  console.error('MongoDB connection error:', error);
  isConnected = false;
});

client.on('close', () => {
  console.log('⚠️ MongoDB connection closed');
  isConnected = false;
  db = null;
});

// ============= JWT MIDDLEWARE =============
const verifyJWT = async (req, res, next) => {
  const token = req?.headers?.authorization?.split(' ')[1];
  console.log('Token received:', token ? 'Yes' : 'No');
  
  if (!token) {
    return res.status(401).send({ message: 'Unauthorized Access - No token!' });
  }
  
  try {
    const decoded = await admin.auth().verifyIdToken(token);
    req.tokenEmail = decoded.email;
    console.log('Decoded token email:', decoded.email);
    next();
  } catch (err) {
    console.log('Token verification error:', err);
    return res.status(401).send({ message: 'Unauthorized Access - Invalid token!', error: err.message });
  }
};

// ============= TEST ROUTES =============
app.get('/', (req, res) => {
  res.send('Hello from ClubSphere Server!');
});

app.get('/debug', async (req, res) => {
  try {
    await connectDB();
    res.json({
      message: 'Server is running!',
      env: {
        hasMongoURI: !!process.env.MONGODB_URI,
        hasFirebase: !!process.env.FIREBASE_SERVICE_ACCOUNT,
        nodeEnv: process.env.NODE_ENV || 'development'
      },
      dbConnected: isConnected,
      dbName: db?.databaseName || 'Not connected'
    });
  } catch (error) {
    res.status(500).json({ error: error.message });
  }
});

// ============= ROUTES =============

// ====== CLUB ROUTES ======

// Add new club
app.post('/clubs', verifyJWT, async (req, res) => {
  try {
    await connectDB();
    const clubCollection = db.collection('clubs');
    const clubData = req.body;
    const result = await clubCollection.insertOne(clubData);
    res.send(result);
  } catch (error) {
    console.error('Error adding club:', error);
    res.status(500).send({ error: error.message });
  }
});

// Get all clubs
app.get('/clubs', async (req, res) => {
  try {
    await connectDB();
    const clubCollection = db.collection('clubs');
    const result = await clubCollection.find().toArray();
    console.log('📋 Fetched clubs:', result.length);
    res.send(result);
  } catch (error) {
    console.error('Error fetching clubs:', error);
    res.status(500).send({ error: error.message });
  }
});

// Get single club by ID
app.get('/clubs/:id', async (req, res) => {
  try {
    await connectDB();
    const clubCollection = db.collection('clubs');
    const id = req.params.id;
    const result = await clubCollection.findOne({ _id: new ObjectId(id) });
    res.send(result);
  } catch (error) {
    console.error('Error fetching club:', error);
    res.status(500).send({ error: error.message });
  }
});

// Update club
app.patch('/clubs/:id', async (req, res) => {
  try {
    await connectDB();
    const clubCollection = db.collection('clubs');
    const id = req.params.id;
    const clubData = req.body;
    console.log('Updating club:', id);

    delete clubData._id;

    const existingClub = await clubCollection.findOne({ _id: new ObjectId(id) });
    if (!existingClub) {
      return res.status(404).send({ error: 'Club not found' });
    }

    const result = await clubCollection.updateOne(
      { _id: new ObjectId(id) },
      {
        $set: {
          ...clubData,
          updatedAt: new Date()
        }
      }
    );

    if (result.modifiedCount === 0) {
      return res.status(400).send({ error: 'No changes made to club' });
    }

    console.log('Club updated successfully:', id);
    res.send({ success: true, message: 'Club updated successfully' });
  } catch (error) {
    console.error('Error updating club:', error);
    res.status(500).send({ error: error.message });
  }
});

// Delete club
app.delete('/clubs/:id', async (req, res) => {
  try {
    await connectDB();
    const clubCollection = db.collection('clubs');
    const bookingCollection = db.collection('bookings');
    const id = req.params.id;
    console.log('Deleting club:', id);

    const club = await clubCollection.findOne({ _id: new ObjectId(id) });
    if (!club) {
      return res.status(404).send({ error: 'Club not found' });
    }

    const activeBookings = await bookingCollection.findOne({
      clubId: id,
      status: { $nin: ['cancelled', 'completed'] }
    });

    if (activeBookings) {
      return res.status(400).send({
        error: 'Cannot delete club with active bookings. Please complete or cancel all bookings first.'
      });
    }

    const result = await clubCollection.deleteOne({ _id: new ObjectId(id) });
    console.log('Club deleted successfully:', id);
    res.send({
      success: true,
      message: 'Club deleted successfully',
      deletedCount: result.deletedCount
    });
  } catch (error) {
    console.error('Error deleting club:', error);
    res.status(500).send({ error: error.message });
  }
});

// Approve or Reject a club
app.patch('/clubs/:id/status', verifyJWT, async (req, res) => {
  try {
    await connectDB();
    const clubCollection = db.collection('clubs');
    const { id } = req.params;
    const { status } = req.body;

    if (!['approved', 'rejected'].includes(status)) {
      return res.status(400).send({ message: 'Invalid status. Use "approved" or "rejected"' });
    }

    const result = await clubCollection.updateOne(
      { _id: new ObjectId(id) },
      {
        $set: {
          status,
          updatedAt: new Date()
        }
      }
    );

    if (result.matchedCount === 0) {
      return res.status(404).send({ message: 'Club not found' });
    }

    console.log(`Club ${id} status updated to: ${status}`);
    res.send({ success: true, message: `Club ${status} successfully`, modifiedCount: result.modifiedCount });
  } catch (error) {
    console.error('Error updating club status:', error);
    res.status(500).send({ message: 'Server error', error: error.message });
  }
});

// POST /clubs/:id/join - Free club instant join
app.post('/clubs/:id/join', verifyJWT, async (req, res) => {
  try {
    await connectDB();
    const clubCollection = db.collection('clubs');
    const bookingCollection = db.collection('bookings');
    
    const clubId = req.params.id;
    const userEmail = req.tokenEmail;

    if (!userEmail) {
      return res.status(401).send({ message: 'Unauthorized' });
    }

    const club = await clubCollection.findOne({ _id: new ObjectId(clubId) });
    if (!club) {
      return res.status(404).send({ message: 'Club not found' });
    }
    if (club.price > 0) {
      return res.status(400).send({ message: 'This club requires payment' });
    }

    const existing = await bookingCollection.findOne({
      clubId: clubId,
      'customer.email': userEmail,
    });
    if (existing) {
      return res.status(409).send({ message: 'You are already a member of this club' });
    }

    const bookingData = {
      clubId: clubId,
      name: club.name,
      image: club.image,
      category: club.category,
      price: 0,
      quantity: 1,
      status: 'confirmed',
      customer: {
        email: userEmail,
      },
      seller: club.seller || {},
      createdAt: new Date(),
      isFreeMembership: true,
    };

    const result = await bookingCollection.insertOne(bookingData);
    res.send({
      success: true,
      message: 'Successfully joined the club for free!',
      bookingId: result.insertedId,
    });
  } catch (error) {
    console.error('Error in free club join:', error);
    res.status(500).send({ message: 'Server error', error: error.message });
  }
});

// ====== BOOKING ROUTES ======

// Get customer orders
app.get('/my-orders', verifyJWT, async (req, res) => {
  try {
    await connectDB();
    const bookingCollection = db.collection('bookings');
    const email = req.tokenEmail;
    console.log('Fetching orders for customer:', email);

    const result = await bookingCollection
      .find({ 'customer.email': email })
      .toArray();

    console.log('Found customer orders:', result.length);
    res.send(result);
  } catch (error) {
    console.error('Error fetching customer orders:', error);
    res.status(500).send({ error: error.message });
  }
});

// Get seller orders
app.get('/manage-orders', verifyJWT, async (req, res) => {
  try {
    await connectDB();
    const bookingCollection = db.collection('bookings');
    const usersCollection = db.collection('users');
    const email = req.tokenEmail;
    
    const user = await usersCollection.findOne({ email });
    if (user?.role !== 'manager') {
      return res.status(403).send({ message: 'Manager only Actions!' });
    }

    console.log('Fetching orders for seller:', email);
    const result = await bookingCollection
      .find({ 'seller.email': email })
      .toArray();

    console.log('Found seller orders:', result.length);
    res.status(200).send(result);
  } catch (error) {
    console.error('Error fetching seller orders:', error);
    res.status(500).send({ error: error.message });
  }
});

// Cancel/Delete order
app.delete('/orders/:id', verifyJWT, async (req, res) => {
  try {
    await connectDB();
    const bookingCollection = db.collection('bookings');
    const id = req.params.id;
    const userEmail = req.tokenEmail;
    console.log('Cancelling order:', id, 'by user:', userEmail);

    const order = await bookingCollection.findOne({ _id: new ObjectId(id) });
    if (!order) {
      console.log('Order not found:', id);
      return res.status(404).send({ error: 'Order not found' });
    }

    const isCustomer = order.customer?.email === userEmail;
    const isSeller = order.seller?.email === userEmail;

    if (!isCustomer && !isSeller) {
      return res.status(403).send({ error: 'Unauthorized to cancel this order' });
    }

    if (order.status === 'completed') {
      return res.status(400).send({ error: 'Cannot cancel completed orders' });
    }

    const result = await bookingCollection.deleteOne({ _id: new ObjectId(id) });
    console.log('Order deleted successfully:', id);
    res.send({
      success: true,
      message: 'Order deleted successfully',
      deletedCount: result.deletedCount
    });
  } catch (error) {
    console.error('Error deleting order:', error);
    res.status(500).send({ error: error.message });
  }
});

// Update order status
app.patch('/orders/:id', async (req, res) => {
  try {
    await connectDB();
    const bookingCollection = db.collection('bookings');
    const id = req.params.id;
    const { status } = req.body;
    console.log('Updating order status:', id, 'to', status);

    const validStatuses = ['confirmed', 'processing', 'completed', 'cancelled'];
    if (!validStatuses.includes(status)) {
      return res.status(400).send({ error: 'Invalid status value' });
    }

    const order = await bookingCollection.findOne({ _id: new ObjectId(id) });
    if (!order) {
      return res.status(404).send({ error: 'Order not found' });
    }

    const updateData = {
      status,
      updatedAt: new Date()
    };

    if (status === 'completed') {
      updateData.completedAt = new Date();
    }

    await bookingCollection.updateOne(
      { _id: new ObjectId(id) },
      { $set: updateData }
    );

    console.log('Order status updated successfully:', id);
    res.send({ success: true, message: 'Order status updated successfully' });
  } catch (error) {
    console.error('Error updating order status:', error);
    res.status(500).send({ error: error.message });
  }
});

// ====== USER ROUTES ======

// Save or update a user
app.post('/user', async (req, res) => {
  try {
    await connectDB();
    const usersCollection = db.collection('users');
    const userData = req.body;
    userData.created_at = new Date().toISOString();
    userData.last_loggedIn = new Date().toISOString();
    userData.role = 'member';

    const query = { email: userData.email };
    const alreadyExists = await usersCollection.findOne(query);
    console.log('User Already Exists---> ', !!alreadyExists);

    if (alreadyExists) {
      console.log('Updating user info......');
      const result = await usersCollection.updateOne(query, {
        $set: {
          last_loggedIn: new Date().toISOString(),
        },
      });
      return res.send(result);
    }

    console.log('Saving new user info......');
    const result = await usersCollection.insertOne(userData);
    res.send(result);
  } catch (error) {
    console.error('Error saving user:', error);
    res.status(500).send({ error: error.message });
  }
});

// Get user role
app.get('/user/role', verifyJWT, async (req, res) => {
  try {
    await connectDB();
    const usersCollection = db.collection('users');
    const result = await usersCollection.findOne({ email: req.tokenEmail });
    res.send({ role: result?.role });
  } catch (error) {
    res.status(500).send({ error: error.message });
  }
});

// Update user profile
app.patch('/users/:email', verifyJWT, async (req, res) => {
  try {
    await connectDB();
    const usersCollection = db.collection('users');
    const { email } = req.params;
    const { name, photoURL } = req.body;

    if (req.tokenEmail !== email) {
      return res.status(403).send({ message: 'Forbidden: You can only update your own profile' });
    }

    const updateData = { updatedAt: new Date() };
    if (name !== undefined) updateData.name = name;
    if (photoURL !== undefined) updateData.photoURL = photoURL;

    const result = await usersCollection.updateOne(
      { email },
      { $set: updateData }
    );

    if (result.matchedCount === 0) {
      return res.status(404).send({ message: 'User not found' });
    }

    console.log('User profile updated successfully:', email);
    res.send({ success: true, message: 'Profile updated successfully', modifiedCount: result.modifiedCount });
  } catch (error) {
    console.error('Error updating user profile:', error);
    res.status(500).send({ error: error.message });
  }
});

// Become manager request
app.post('/become-manager', verifyJWT, async (req, res) => {
  try {
    await connectDB();
    const managerRequestsCollection = db.collection('managerRequests');
    const email = req.tokenEmail;
    const alreadyExists = await managerRequestsCollection.findOne({ email });
    if (alreadyExists) {
      return res.status(409).send({ message: 'Already requested.' });
    }
    const result = await managerRequestsCollection.insertOne({ email });
    res.send(result);
  } catch (error) {
    res.status(500).send({ error: error.message });
  }
});

// Get all manager requests (admin only)
app.get('/manager-requests', verifyJWT, async (req, res) => {
  try {
    await connectDB();
    const usersCollection = db.collection('users');
    const managerRequestsCollection = db.collection('managerRequests');
    const email = req.tokenEmail;
    const user = await usersCollection.findOne({ email });
    if (user?.role !== 'admin') {
      return res.status(403).send({ message: 'Admin only Actions!' });
    }
    const result = await managerRequestsCollection.find().toArray();
    res.send(result);
  } catch (error) {
    res.status(500).send({ error: error.message });
  }
});

// Update user role (admin only)
app.patch('/update-role', verifyJWT, async (req, res) => {
  try {
    await connectDB();
    const usersCollection = db.collection('users');
    const managerRequestsCollection = db.collection('managerRequests');
    const email = req.tokenEmail;
    const user = await usersCollection.findOne({ email });
    if (user?.role !== 'admin') {
      return res.status(403).send({ message: 'Admin only Actions!' });
    }
    const { email: targetEmail, role } = req.body;
    const result = await usersCollection.updateOne(
      { email: targetEmail },
      { $set: { role } }
    );
    await managerRequestsCollection.deleteOne({ email: targetEmail });
    res.send(result);
  } catch (error) {
    res.status(500).send({ error: error.message });
  }
});

// Get all users (admin only)
app.get('/users', verifyJWT, async (req, res) => {
  try {
    await connectDB();
    const usersCollection = db.collection('users');
    const email = req.tokenEmail;
    const user = await usersCollection.findOne({ email });
    if (user?.role !== 'admin') {
      return res.status(403).send({ message: 'Admin only Actions!' });
    }
    const result = await usersCollection
      .find({ email: { $ne: email } })
      .toArray();
    res.send(result);
  } catch (error) {
    res.status(500).send({ error: error.message });
  }
});

// ====== EVENT ROUTES ======

// Create event
app.post('/events', verifyJWT, async (req, res) => {
  try {
    await connectDB();
    const eventsCollection = db.collection('events');
    const clubCollection = db.collection('clubs');
    const usersCollection = db.collection('users');
    
    const { clubId, title, description, eventDate, location, isPaid, eventFee, maxAttendees } = req.body;
    const email = req.tokenEmail;

    const user = await usersCollection.findOne({ email });
    if (user?.role !== 'manager') {
      return res.status(403).send({ error: 'Manager only Actions!' });
    }

    const club = await clubCollection.findOne({ _id: new ObjectId(clubId) });
    if (!club || club.seller?.email !== email) {
      return res.status(403).send({ error: 'You can only create events for your own clubs' });
    }

    const eventData = {
      clubId,
      title,
      description,
      eventDate: new Date(eventDate),
      location,
      isPaid: !!isPaid,
      eventFee: eventFee || 0,
      maxAttendees: maxAttendees || null,
      managerEmail: email,
      createdAt: new Date(),
    };

    const result = await eventsCollection.insertOne(eventData);
    res.send({ success: true, message: 'Event created successfully', eventId: result.insertedId });
  } catch (error) {
    console.error('Error creating event:', error);
    res.status(500).send({ error: error.message });
  }
});

// Get all events
app.get('/events', async (req, res) => {
  try {
    await connectDB();
    const eventsCollection = db.collection('events');
    const { sort } = req.query;

    let sortConfig = {};
    switch (sort) {
      case 'newest':
        sortConfig = { eventDate: -1, createdAt: -1 };
        break;
      case 'oldest':
        sortConfig = { eventDate: 1, createdAt: 1 };
        break;
      case 'fee-high':
        sortConfig = { eventFee: -1, eventDate: -1 };
        break;
      case 'fee-low':
        sortConfig = { eventFee: 1, eventDate: -1 };
        break;
      default:
        sortConfig = { eventDate: -1 };
    }

    const events = await eventsCollection
      .find({})
      .sort(sortConfig)
      .toArray();

    res.send(events);
  } catch (error) {
    console.error('Error fetching events:', error);
    res.status(500).send({ error: error.message });
  }
});

// Get single event
app.get('/events/:id', async (req, res) => {
  try {
    await connectDB();
    const eventsCollection = db.collection('events');
    const id = req.params.id;

    if (!ObjectId.isValid(id)) {
      return res.status(400).send({ message: 'Invalid event ID' });
    }

    const event = await eventsCollection.findOne({ _id: new ObjectId(id) });
    if (!event) {
      return res.status(404).send({ message: 'Event not found' });
    }
    res.send(event);
  } catch (error) {
    console.error('Error fetching event:', error);
    res.status(500).send({ error: error.message });
  }
});

// Update event
app.patch('/events/:id', verifyJWT, async (req, res) => {
  try {
    await connectDB();
    const eventsCollection = db.collection('events');
    const usersCollection = db.collection('users');
    
    const email = req.tokenEmail;
    const user = await usersCollection.findOne({ email });
    if (user?.role !== 'manager') {
      return res.status(403).send({ error: 'Manager only Actions!' });
    }

    const id = req.params.id;
    const event = await eventsCollection.findOne({ _id: new ObjectId(id) });
    if (!event) {
      return res.status(404).send({ message: 'Event not found' });
    }
    if (event.managerEmail !== email) {
      return res.status(403).send({ message: 'Forbidden: You do not own this event' });
    }

    const updateData = { ...req.body, updatedAt: new Date() };
    delete updateData._id;

    const result = await eventsCollection.updateOne(
      { _id: new ObjectId(id) },
      { $set: updateData }
    );

    res.send({ success: true, message: 'Event updated successfully' });
  } catch (error) {
    console.error('Error updating event:', error);
    res.status(500).send({ error: error.message });
  }
});

// Delete event
app.delete('/events/:id', verifyJWT, async (req, res) => {
  try {
    await connectDB();
    const eventsCollection = db.collection('events');
    const eventRegistrationsCollection = db.collection('eventRegistrations');
    const usersCollection = db.collection('users');
    
    const email = req.tokenEmail;
    const user = await usersCollection.findOne({ email });
    if (user?.role !== 'manager') {
      return res.status(403).send({ error: 'Manager only Actions!' });
    }

    const id = req.params.id;
    const event = await eventsCollection.findOne({ _id: new ObjectId(id) });
    if (!event) {
      return res.status(404).send({ message: 'Event not found' });
    }
    if (event.managerEmail !== email) {
      return res.status(403).send({ message: 'Forbidden: You do not own this event' });
    }

    const hasRegistrations = await eventRegistrationsCollection.findOne({ eventId: id });
    if (hasRegistrations) {
      return res.status(400).send({ error: 'Cannot delete event with registrations' });
    }

    const result = await eventsCollection.deleteOne({ _id: new ObjectId(id) });
    res.send({ success: true, message: 'Event deleted successfully', deletedCount: result.deletedCount });
  } catch (error) {
    console.error('Error deleting event:', error);
    res.status(500).send({ error: error.message });
  }
});

// Register for a FREE event
app.post('/events/:id/register', verifyJWT, async (req, res) => {
  try {
    await connectDB();
    const eventsCollection = db.collection('events');
    const eventRegistrationsCollection = db.collection('eventRegistrations');
    
    const eventId = req.params.id;
    const userEmail = req.tokenEmail;

    const event = await eventsCollection.findOne({ _id: new ObjectId(eventId) });
    if (!event) return res.status(404).send({ error: 'Event not found' });

    if (event.isPaid) {
      return res.status(400).send({ error: 'This event requires payment. Please use the checkout flow.' });
    }

    const existing = await eventRegistrationsCollection.findOne({ eventId, userEmail });
    if (existing) return res.status(409).send({ error: 'Already registered' });

    const registration = {
      eventId,
      userEmail,
      status: 'registered',
      registeredAt: new Date()
    };

    const result = await eventRegistrationsCollection.insertOne(registration);
    res.send({ success: true, message: 'Registered successfully', registrationId: result.insertedId });
  } catch (error) {
    console.error('Error registering:', error);
    res.status(500).send({ error: error.message });
  }
});

// Get event registrations (manager only)
app.get('/events/:id/registrations', verifyJWT, async (req, res) => {
  try {
    await connectDB();
    const eventsCollection = db.collection('events');
    const eventRegistrationsCollection = db.collection('eventRegistrations');
    const usersCollection = db.collection('users');
    
    const email = req.tokenEmail;
    const user = await usersCollection.findOne({ email });
    if (user?.role !== 'manager') {
      return res.status(403).send({ error: 'Manager only Actions!' });
    }

    const eventId = req.params.id;
    const event = await eventsCollection.findOne({ _id: new ObjectId(eventId) });
    if (!event) {
      return res.status(404).send({ message: 'Event not found' });
    }
    if (event.managerEmail !== email) {
      return res.status(403).send({ message: 'Forbidden: You do not own this event' });
    }

    const registrations = await eventRegistrationsCollection
      .find({ eventId })
      .project({ userEmail: 1, status: 1, registeredAt: 1 })
      .toArray();

    res.send(registrations);
  } catch (error) {
    console.error('Error fetching registrations:', error);
    res.status(500).send({ error: error.message });
  }
});

// Cancel event registration
app.patch('/events/:id/cancel', verifyJWT, async (req, res) => {
  try {
    await connectDB();
    const eventRegistrationsCollection = db.collection('eventRegistrations');
    
    const eventId = req.params.id;
    const userEmail = req.tokenEmail;

    const result = await eventRegistrationsCollection.updateOne(
      { eventId, userEmail },
      { $set: { status: 'cancelled', updatedAt: new Date() } }
    );

    if (result.matchedCount === 0) return res.status(404).send({ error: 'Registration not found' });
    res.send({ success: true, message: 'Registration cancelled' });
  } catch (error) {
    console.error('Error cancelling registration:', error);
    res.status(500).send({ error: error.message });
  }
});

// Get user's registrations
app.get('/my-registrations', verifyJWT, async (req, res) => {
  try {
    await connectDB();
    const eventRegistrationsCollection = db.collection('eventRegistrations');
    const email = req.tokenEmail;
    const result = await eventRegistrationsCollection
      .find({ userEmail: email })
      .project({ eventId: 1, status: 1 })
      .toArray();
    res.send(result);
  } catch (error) {
    res.status(500).send({ error: error.message });
  }
});

// Get user's events
app.get('/my-events', verifyJWT, async (req, res) => {
  try {
    await connectDB();
    const eventsCollection = db.collection('events');
    const clubCollection = db.collection('clubs');
    const eventRegistrationsCollection = db.collection('eventRegistrations');
    
    const email = req.tokenEmail;
    console.log('Fetching my events for:', email);

    const registrations = await eventRegistrationsCollection
      .find({ userEmail: email, status: { $ne: 'cancelled' } })
      .toArray();

    if (registrations.length === 0) {
      return res.status(200).send([]);
    }

    const eventIds = registrations.map(reg => reg.eventId);
    const events = await eventsCollection
      .find({ _id: { $in: eventIds.map(id => new ObjectId(id)) } })
      .toArray();

    const clubIds = events.map(e => e.clubId);
    const clubs = await clubCollection
      .find({ _id: { $in: clubIds.map(id => new ObjectId(id)) } })
      .toArray();

    const clubMap = clubs.reduce((map, club) => {
      map[club._id.toString()] = club.name;
      return map;
    }, {});

    const myEvents = events.map(event => ({
      _id: event._id,
      title: event.title,
      clubName: clubMap[event.clubId?.toString()] || 'Unknown Club',
      date: event.eventDate ? new Date(event.eventDate).toISOString().split('T')[0] : '',
      fee: event.eventFee || 0,
      isPaid: event.isPaid || false,
      status: 'Confirmed',
    }));

    res.status(200).send(myEvents);
  } catch (error) {
    console.error('Error fetching my events:', error);
    res.status(500).send({ error: error.message });
  }
});

// Get all registrations for manager's clubs
app.get('/manager/all-registrations', verifyJWT, async (req, res) => {
  try {
    await connectDB();
    const clubCollection = db.collection('clubs');
    const eventsCollection = db.collection('events');
    const eventRegistrationsCollection = db.collection('eventRegistrations');
    const usersCollection = db.collection('users');
    
    const managerEmail = req.tokenEmail;
    const user = await usersCollection.findOne({ email: managerEmail });
    if (user?.role !== 'manager') {
      return res.status(403).send({ error: 'Manager only Actions!' });
    }

    const managerClubs = await clubCollection.find({ 'seller.email': managerEmail }).toArray();
    const clubIds = managerClubs.map(club => club._id.toString());

    const managerEvents = await eventsCollection.find({
      clubId: { $in: clubIds }
    }).toArray();
    const eventIds = managerEvents.map(event => event._id.toString());

    const registrations = await eventRegistrationsCollection
      .find({ eventId: { $in: eventIds } })
      .toArray();

    if (registrations.length === 0) {
      return res.send([]);
    }

    const userEmails = [...new Set(registrations.map(reg => reg.userEmail))];
    const users = await usersCollection.find({ email: { $in: userEmails } }).toArray();
    const userMap = users.reduce((map, user) => {
      map[user.email] = {
        name: user.name || 'Unknown User',
        photo: user.photoURL || '/default-avatar.png'
      };
      return map;
    }, {});

    const detailedRegistrations = registrations.map(reg => {
      const event = managerEvents.find(e => e._id.toString() === reg.eventId);
      const club = managerClubs.find(c => c._id.toString() === event?.clubId);
      const user = userMap[reg.userEmail] || { name: 'Unknown User', photo: '/default-avatar.png' };

      return {
        ...reg,
        eventTitle: event?.title || 'Unknown Event',
        clubName: club?.name || 'Unknown Club',
        userName: user.name,
        userPhoto: user.photo
      };
    });

    res.send(detailedRegistrations);
  } catch (error) {
    console.error('Error fetching manager registrations:', error);
    res.status(500).send({ message: 'Server error', error: error.message });
  }
});

// Approve/Reject registration status
app.patch('/manager/registration/:regId/status', verifyJWT, async (req, res) => {
  try {
    await connectDB();
    const clubCollection = db.collection('clubs');
    const eventsCollection = db.collection('events');
    const eventRegistrationsCollection = db.collection('eventRegistrations');
    const usersCollection = db.collection('users');
    
    const managerEmail = req.tokenEmail;
    const user = await usersCollection.findOne({ email: managerEmail });
    if (user?.role !== 'manager') {
      return res.status(403).send({ error: 'Manager only Actions!' });
    }

    const { regId } = req.params;
    const { status } = req.body;

    if (!['confirmed', 'rejected'].includes(status)) {
      return res.status(400).send({ message: 'Invalid status' });
    }

    const registration = await eventRegistrationsCollection.findOne({ _id: new ObjectId(regId) });
    if (!registration) {
      return res.status(404).send({ message: 'Registration not found' });
    }

    const event = await eventsCollection.findOne({ _id: new ObjectId(registration.eventId) });
    if (!event) return res.status(404).send({ message: 'Event not found' });

    const club = await clubCollection.findOne({ _id: new ObjectId(event.clubId) });
    if (!club || club.seller?.email !== managerEmail) {
      return res.status(403).send({ message: 'Unauthorized: Not your club event' });
    }

    const result = await eventRegistrationsCollection.updateOne(
      { _id: new ObjectId(regId) },
      { $set: { status, updatedAt: new Date() } }
    );

    if (result.modifiedCount === 0) {
      return res.status(400).send({ message: 'Failed to update status' });
    }

    res.send({ message: 'Status updated successfully' });
  } catch (error) {
    console.error('Error updating registration status:', error);
    res.status(500).send({ message: 'Server error' });
  }
});

// ====== PAYMENT ROUTES ======

// Create checkout session
app.post('/create-checkout-session', async (req, res) => {
  const paymentInfo = req.body;
  const type = paymentInfo?.type || 'club';
  console.log('Creating checkout session:', type, paymentInfo);

  try {
    const metadata = {
      type,
      customerEmail: paymentInfo?.customer?.email,
      customerName: paymentInfo?.customer?.name,
      customerImage: paymentInfo?.customer?.image || '',
    };

    if (type === 'club') {
      metadata.clubId = paymentInfo?.clubId;
      metadata.sellerEmail = paymentInfo?.seller?.email || '';
      metadata.sellerName = paymentInfo?.seller?.name || '';
      metadata.sellerImage = paymentInfo?.seller?.image || '';
    }

    if (type === 'event') {
      metadata.eventId = paymentInfo?.eventId;
    }

    const session = await stripe.checkout.sessions.create({
      line_items: [
        {
          price_data: {
            currency: 'usd',
            product_data: {
              name: paymentInfo?.name,
              description: paymentInfo?.description,
              images: [paymentInfo?.image].filter(url => typeof url === 'string' && url.trim().length > 0),
            },
            unit_amount: Math.round(paymentInfo?.price * 100),
          },
          quantity: paymentInfo?.quantity || 1,
        },
      ],
      customer_email: paymentInfo?.customer?.email,
      mode: 'payment',
      metadata,
      success_url: `${process.env.CLIENT_DOMAIN}/payment-success?session_id={CHECKOUT_SESSION_ID}&type=${type}`,
      cancel_url:
        type === 'event'
          ? `${process.env.CLIENT_DOMAIN}/event`
          : `${process.env.CLIENT_DOMAIN}/club/${paymentInfo?.clubId}`,
    });

    console.log('Checkout session created:', session.id);
    res.send({ url: session.url });
  } catch (error) {
    console.error('Stripe error:', error);
    res.status(500).send({ error: error.message });
  }
});

// Verify payment
app.get('/verify-payment/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  console.log('Verifying payment for session:', sessionId);

  try {
    await connectDB();
    const clubCollection = db.collection('clubs');
    const bookingCollection = db.collection('bookings');
    const eventsCollection = db.collection('events');
    const eventRegistrationsCollection = db.collection('eventRegistrations');

    const session = await stripe.checkout.sessions.retrieve(sessionId);
    const type = session.metadata?.type || 'club';
    console.log('Stripe session retrieved:', { id: session.id, payment_status: session.payment_status, type });

    if (session.payment_status !== 'paid') {
      console.log('Payment not completed. Status:', session.payment_status);
      return res.send({ success: false, session, type, message: 'Payment not completed' });
    }

    // ---------- EVENT REGISTRATION FLOW ----------
    if (type === 'event') {
      const existingBySession = await eventRegistrationsCollection.findOne({ sessionId: session.id });
      if (existingBySession) {
        return res.send({
          success: true,
          session,
          type,
          message: 'Registration already recorded',
          registrationId: existingBySession._id,
        });
      }

      const eventId = session.metadata.eventId;
      const event = await eventsCollection.findOne({ _id: new ObjectId(eventId) });
      if (!event) {
        return res.status(404).send({ error: 'Event not found' });
      }

      const alreadyRegistered = await eventRegistrationsCollection.findOne({
        eventId,
        userEmail: session.metadata.customerEmail,
        status: { $ne: 'cancelled' },
      });
      if (alreadyRegistered) {
        return res.send({
          success: true,
          session,
          type,
          message: 'Already registered for this event',
          registrationId: alreadyRegistered._id,
        });
      }

      const registration = {
        eventId,
        userEmail: session.metadata.customerEmail,
        customerName: session.metadata.customerName,
        status: 'registered',
        sessionId: session.id,
        transactionId: session.payment_intent,
        amountPaid: session.amount_total / 100,
        registeredAt: new Date(),
      };

      const result = await eventRegistrationsCollection.insertOne(registration);
      console.log('Event registration saved:', result.insertedId);

      return res.send({
        success: true,
        session,
        type,
        message: 'Registered and payment confirmed',
        registrationId: result.insertedId,
      });
    }

    // ---------- CLUB BOOKING FLOW ----------
    const existingBooking = await bookingCollection.findOne({ sessionId: session.id });
    if (existingBooking) {
      console.log('Booking already exists:', existingBooking._id);
      return res.send({
        success: true,
        session,
        type,
        message: 'Booking already recorded',
        bookingId: existingBooking._id
      });
    }

    const club = await clubCollection.findOne({ _id: new ObjectId(session.metadata.clubId) });
    if (!club) {
      console.log('Club not found:', session.metadata.clubId);
      return res.status(404).send({ error: 'Club not found' });
    }

    const seller = {
      email: session.metadata.sellerEmail || club.seller?.email,
      name: session.metadata.sellerName || club.seller?.name,
      image: session.metadata.sellerImage || club.seller?.image,
    };

    const bookingData = {
      sessionId: session.id,
      clubId: session.metadata.clubId,
      transactionId: session.payment_intent,
      customer: {
        name: session.metadata.customerName,
        email: session.metadata.customerEmail,
        image: session.metadata.customerImage,
      },
      status: 'confirmed',
      seller,
      name: club.name,
      category: club.category,
      quantity: 1,
      price: session.amount_total / 100,
      image: club.image,
      createdAt: new Date(),
    };

    const result = await bookingCollection.insertOne(bookingData);
    console.log('Booking saved successfully! ID:', result.insertedId);

    res.send({
      success: true,
      session,
      type,
      bookingId: result.insertedId,
      message: 'Booking created successfully'
    });
  } catch (error) {
    console.error('Payment verification error:', error);
    res.status(500).send({ error: error.message });
  }
});

// Get payment history
app.get('/payment-history', verifyJWT, async (req, res) => {
  try {
    await connectDB();
    const bookingCollection = db.collection('bookings');
    const email = req.tokenEmail;
    console.log('Fetching payment history for:', email);

    const transactions = await bookingCollection
      .find({ 'customer.email': email })
      .sort({ createdAt: -1 })
      .toArray();

    const formattedTransactions = transactions.map(t => ({
      _id: t._id,
      amount: t.price,
      type: 'Club Membership',
      clubName: t.name,
      date: new Date(t.createdAt).toISOString().split('T')[0],
      status: t.status === 'confirmed' ? 'Completed' : t.status.charAt(0).toUpperCase() + t.status.slice(1),
    }));

    res.status(200).send(formattedTransactions);
  } catch (error) {
    console.error('Error fetching payment history:', error);
    res.status(500).send({ error: error.message });
  }
});

// ====== BOOKMARK ROUTES ======

// Get event bookmarks
app.get('/my-bookmarks', verifyJWT, async (req, res) => {
  try {
    await connectDB();
    const bookmarksCollection = db.collection('bookmarks');
    const bookmarks = await bookmarksCollection
      .find({ userId: req.tokenEmail })
      .toArray();
    res.json(bookmarks);
  } catch (error) {
    console.error('Error fetching bookmarks:', error);
    res.status(500).json({ error: error.message });
  }
});

// Add event bookmark
app.post('/events/:id/bookmark', verifyJWT, async (req, res) => {
  try {
    await connectDB();
    const bookmarksCollection = db.collection('bookmarks');
    const eventId = req.params.id;
    const userEmail = req.tokenEmail;

    const existingBookmark = await bookmarksCollection.findOne({
      userId: userEmail,
      eventId: eventId
    });

    if (existingBookmark) {
      return res.status(400).json({ error: 'Already bookmarked' });
    }

    const bookmark = {
      userId: userEmail,
      eventId: eventId,
      createdAt: new Date()
    };

    const result = await bookmarksCollection.insertOne(bookmark);
    res.status(201).json({ ...bookmark, _id: result.insertedId });
  } catch (error) {
    console.error('Error adding bookmark:', error);
    res.status(500).json({ error: error.message });
  }
});

// Remove event bookmark
app.delete('/events/:id/bookmark', verifyJWT, async (req, res) => {
  try {
    await connectDB();
    const bookmarksCollection = db.collection('bookmarks');
    const eventId = req.params.id;
    const userEmail = req.tokenEmail;

    const result = await bookmarksCollection.deleteOne({
      userId: userEmail,
      eventId: eventId
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({ error: 'Bookmark not found' });
    }

    res.json({ message: 'Bookmark removed successfully' });
  } catch (error) {
    console.error('Error removing bookmark:', error);
    res.status(500).json({ error: error.message });
  }
});

// Get club bookmarks
app.get('/my-club-bookmarks', verifyJWT, async (req, res) => {
  try {
    await connectDB();
    const bookmarksCollection = db.collection('bookmarks');
    const bookmarks = await bookmarksCollection
      .find({ userId: req.tokenEmail, type: 'club' })
      .toArray();
    res.json(bookmarks);
  } catch (error) {
    console.error('Error fetching club bookmarks:', error);
    res.status(500).json({ error: error.message });
  }
});

// Add club bookmark
app.post('/clubs/:id/bookmark', verifyJWT, async (req, res) => {
  try {
    await connectDB();
    const bookmarksCollection = db.collection('bookmarks');
    const clubId = req.params.id;
    const userEmail = req.tokenEmail;

    const existingBookmark = await bookmarksCollection.findOne({
      userId: userEmail,
      clubId: clubId,
      type: 'club'
    });

    if (existingBookmark) {
      return res.status(400).json({ error: 'Already bookmarked' });
    }

    const bookmark = {
      userId: userEmail,
      clubId: clubId,
      type: 'club',
      createdAt: new Date()
    };

    const result = await bookmarksCollection.insertOne(bookmark);
    res.status(201).json({ ...bookmark, _id: result.insertedId });
  } catch (error) {
    console.error('Error adding club bookmark:', error);
    res.status(500).json({ error: error.message });
  }
});

// Remove club bookmark
app.delete('/clubs/:id/bookmark', verifyJWT, async (req, res) => {
  try {
    await connectDB();
    const bookmarksCollection = db.collection('bookmarks');
    const clubId = req.params.id;
    const userEmail = req.tokenEmail;

    const result = await bookmarksCollection.deleteOne({
      userId: userEmail,
      clubId: clubId,
      type: 'club'
    });

    if (result.deletedCount === 0) {
      return res.status(404).json({ error: 'Bookmark not found' });
    }

    res.json({ message: 'Club bookmark removed successfully' });
  } catch (error) {
    console.error('Error removing club bookmark:', error);
    res.status(500).json({ error: error.message });
  }
});

// ====== MANAGER STATISTICS ======

// Get manager statistics
app.get('/manager/statistics', verifyJWT, async (req, res) => {
  try {
    await connectDB();
    const clubCollection = db.collection('clubs');
    const bookingCollection = db.collection('bookings');
    const usersCollection = db.collection('users');
    
    const email = req.tokenEmail;
    const user = await usersCollection.findOne({ email });
    if (user?.role !== 'manager') {
      return res.status(403).send({ error: 'Manager only Actions!' });
    }

    console.log('Fetching statistics for manager:', email);

    const managedClubs = await clubCollection
      .find({ 'seller.email': email })
      .toArray();

    const clubIds = managedClubs.map(club => club._id.toString());
    const allBookings = await bookingCollection
      .find({ clubId: { $in: clubIds } })
      .toArray();

    const now = new Date();
    const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
    const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
    const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0);
    const thirtyDaysAgo = new Date(now.getTime() - 30 * 24 * 60 * 60 * 1000);

    const uniqueCustomers = [...new Set(allBookings.map(b => b.customer?.email))].filter(Boolean);
    const totalMembers = uniqueCustomers.length;

    const newMembersThisMonth = allBookings.filter(
      b => new Date(b.createdAt) >= startOfMonth
    ).length;

    const newMembersLastMonth = allBookings.filter(
      b => new Date(b.createdAt) >= startOfLastMonth && new Date(b.createdAt) <= endOfLastMonth
    ).length;

    const membersTrend = newMembersLastMonth > 0
      ? Math.round(((newMembersThisMonth - newMembersLastMonth) / newMembersLastMonth) * 100)
      : 0;

    const activeEvents = allBookings.filter(
      b => b.status === 'confirmed' || b.status === 'processing'
    ).length;

    const upcomingEvents = allBookings.filter(b => b.status === 'confirmed').length;
    const pendingRequests = allBookings.filter(b => b.status === 'processing').length;

    const completedBookings = allBookings.filter(b => b.status === 'completed').length;
    const averageAttendance = allBookings.length > 0
      ? Math.round((completedBookings / allBookings.length) * 100)
      : 0;

    const completedThisMonth = allBookings.filter(
      b => b.status === 'completed' && new Date(b.completedAt || b.createdAt) >= startOfMonth
    ).length;
    const completedLastMonth = allBookings.filter(
      b => b.status === 'completed' &&
        new Date(b.completedAt || b.createdAt) >= startOfLastMonth &&
        new Date(b.completedAt || b.createdAt) <= endOfLastMonth
    ).length;
    const attendanceTrend = completedLastMonth > 0
      ? Math.round(((completedThisMonth - completedLastMonth) / completedLastMonth) * 100)
      : 0;

    const bookingsLast30Days = allBookings.filter(
      b => new Date(b.createdAt) >= thirtyDaysAgo
    ).length;
    const bookingsPrevious30Days = allBookings.filter(
      b => {
        const date = new Date(b.createdAt);
        const sixtyDaysAgo = new Date(now.getTime() - 60 * 24 * 60 * 60 * 1000);
        return date >= sixtyDaysAgo && date < thirtyDaysAgo;
      }
    ).length;
    const growthRate = bookingsPrevious30Days > 0
      ? Math.round(((bookingsLast30Days - bookingsPrevious30Days) / bookingsPrevious30Days) * 100)
      : 0;

    const totalEventHours = completedBookings * 2;
    const eventCompletionRate = allBookings.length > 0
      ? Math.round((completedBookings / allBookings.length) * 100)
      : 0;

    const performanceData = {
      memberGrowth: membersTrend > 0 ? membersTrend : 0,
      eventSuccess: eventCompletionRate,
      engagement: averageAttendance
    };

    const statistics = {
      totalMembers,
      totalClubs: managedClubs.length,
      activeEvents,
      upcomingEvents,
      newMembersThisMonth,
      pendingRequests,
      averageAttendance,
      growthRate,
      totalEventHours,
      eventCompletionRate,
      membersTrend,
      newMembersTrend: membersTrend,
      attendanceTrend,
      performanceData
    };

    console.log('Manager statistics:', statistics);
    res.send(statistics);
  } catch (error) {
    console.error('Error fetching manager statistics:', error);
    res.status(500).send({ error: error.message });
  }
});

// Get manager's clubs
app.get('/manager/clubs', verifyJWT, async (req, res) => {
  try {
    await connectDB();
    const clubCollection = db.collection('clubs');
    const usersCollection = db.collection('users');
    
    const email = req.tokenEmail;
    const user = await usersCollection.findOne({ email });
    if (user?.role !== 'manager') {
      return res.status(403).send({ error: 'Manager only Actions!' });
    }

    console.log('Fetching clubs for manager:', email);
    const clubs = await clubCollection
      .find({ 'seller.email': email })
      .toArray();

    res.send(clubs);
  } catch (error) {
    console.error('Error fetching manager clubs:', error);
    res.status(500).send({ error: error.message });
  }
});

// Get manager inventory
app.get('/my-inventory', verifyJWT, async (req, res) => {
  try {
    await connectDB();
    const clubCollection = db.collection('clubs');
    const usersCollection = db.collection('users');
    
    const email = req.tokenEmail;
    const user = await usersCollection.findOne({ email });
    if (user?.role !== 'manager') {
      return res.status(403).send({ error: 'Manager only Actions!' });
    }

    console.log('🔍 Fetching inventory for user:', email);
    const result = await clubCollection
      .find({ 'seller.email': email })
      .toArray();

    console.log('📦 Found clubs in inventory:', result.length);
    res.send(result);
  } catch (error) {
    console.error('❌ Error fetching inventory:', error);
    res.status(500).send({ error: error.message });
  }
});

// Get manager's upcoming events
app.get('/manager/upcoming-events', verifyJWT, async (req, res) => {
  try {
    await connectDB();
    const clubCollection = db.collection('clubs');
    const bookingCollection = db.collection('bookings');
    const usersCollection = db.collection('users');
    
    const email = req.tokenEmail;
    const user = await usersCollection.findOne({ email });
    if (user?.role !== 'manager') {
      return res.status(403).send({ error: 'Manager only Actions!' });
    }

    console.log('Fetching upcoming events for manager:', email);

    const managedClubs = await clubCollection
      .find({ 'seller.email': email })
      .toArray();

    const clubIds = managedClubs.map(club => club._id.toString());
    const bookings = await bookingCollection
      .find({
        clubId: { $in: clubIds },
        status: 'confirmed'
      })
      .sort({ createdAt: -1 })
      .limit(7)
      .toArray();

    const events = bookings.map(booking => {
      const date = new Date(booking.createdAt);
      const monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];

      return {
        title: `${booking.name} Session`,
        clubName: booking.name,
        date: `${monthNames[date.getMonth()]} ${date.getDate()}`,
        time: date.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit' }),
        registeredCount: 1,
        capacity: 30,
        bookingId: booking._id
      };
    });

    console.log('Upcoming events:', events.length);
    res.send(events);
  } catch (error) {
    console.error('Error fetching upcoming events:', error);
    res.status(500).send({ error: error.message });
  }
});

// Get manager's pending requests
app.get('/manager/pending-requests', verifyJWT, async (req, res) => {
  try {
    await connectDB();
    const clubCollection = db.collection('clubs');
    const bookingCollection = db.collection('bookings');
    const usersCollection = db.collection('users');
    
    const email = req.tokenEmail;
    const user = await usersCollection.findOne({ email });
    if (user?.role !== 'manager') {
      return res.status(403).send({ error: 'Manager only Actions!' });
    }

    console.log('Fetching pending requests for manager:', email);

    const managedClubs = await clubCollection
      .find({ 'seller.email': email })
      .toArray();

    const clubIds = managedClubs.map(club => club._id.toString());
    const processingBookings = await bookingCollection
      .find({
        clubId: { $in: clubIds },
        status: 'processing'
      })
      .sort({ createdAt: -1 })
      .toArray();

    const requests = processingBookings.map(booking => {
      const date = new Date(booking.createdAt);
      const now = new Date();
      const diffTime = Math.abs(now - date);
      const diffHours = Math.floor(diffTime / (1000 * 60 * 60));
      const diffDays = Math.floor(diffHours / 24);

      let timeAgo;
      if (diffDays > 0) {
        timeAgo = `${diffDays} day${diffDays > 1 ? 's' : ''} ago`;
      } else if (diffHours > 0) {
        timeAgo = `${diffHours} hour${diffHours > 1 ? 's' : ''} ago`;
      } else {
        timeAgo = 'Just now';
      }

      return {
        type: 'Booking Request',
        description: `${booking.customer?.name} wants to join ${booking.name}`,
        timestamp: timeAgo,
        bookingId: booking._id,
        customerEmail: booking.customer?.email
      };
    });

    console.log('Pending requests:', requests.length);
    res.send(requests);
  } catch (error) {
    console.error('Error fetching pending requests:', error);
    res.status(500).send({ error: error.message });
  }
});

// Approve/Reject pending request
app.patch('/manager/requests/:id', verifyJWT, async (req, res) => {
  try {
    await connectDB();
    const clubCollection = db.collection('clubs');
    const bookingCollection = db.collection('bookings');
    const usersCollection = db.collection('users');
    
    const { id } = req.params;
    const { action } = req.body;
    const email = req.tokenEmail;

    const user = await usersCollection.findOne({ email });
    if (user?.role !== 'manager') {
      return res.status(403).send({ error: 'Manager only Actions!' });
    }

    const booking = await bookingCollection.findOne({ _id: new ObjectId(id) });
    if (!booking) {
      return res.status(404).send({ error: 'Request not found' });
    }

    const club = await clubCollection.findOne({ _id: new ObjectId(booking.clubId) });
    if (club.seller?.email !== email) {
      return res.status(403).send({ error: 'Unauthorized' });
    }

    const newStatus = action === 'approve' ? 'confirmed' : 'cancelled';
    await bookingCollection.updateOne(
      { _id: new ObjectId(id) },
      { $set: { status: newStatus, updatedAt: new Date() } }
    );

    res.send({ success: true, message: `Request ${action}d successfully` });
  } catch (error) {
    console.error('Error handling request:', error);
    res.status(500).send({ error: error.message });
  }
});

// Get all bookings (Admin only)
app.get('/admin/bookings', verifyJWT, async (req, res) => {
  try {
    await connectDB();
    const bookingCollection = db.collection('bookings');
    const usersCollection = db.collection('users');
    
    const email = req.tokenEmail;
    const user = await usersCollection.findOne({ email });
    if (user?.role !== 'admin') {
      return res.status(403).send({ error: 'Admin only Actions!' });
    }

    const result = await bookingCollection.find({}).toArray();
    res.send(result);
  } catch (error) {
    console.error('Error fetching all bookings:', error);
    res.status(500).send({ error: error.message });
  }
});

// ============= START SERVER =============
async function startServer() {
  try {
    await connectDB();
    app.listen(port, () => {
      console.log(`🚀 Server is running on port ${port}`);
      console.log(`📍 URL: http://localhost:${port}`);
    });
  } catch (error) {
    console.error('❌ Failed to start server:', error);
    process.exit(1);
  }
}

// For Vercel serverless deployment
module.exports = app;

// For local development - start server
if (require.main === module) {
  startServer();
}