const express = require('express')
require('dotenv').config()
const cors = require('cors')
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb')
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY)
const port = process.env.PORT || 3000

const admin = require('firebase-admin')
const serviceAccount = require('./serviceAccountKey.json')

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
})

const app = express()

// Middleware
app.use(
  cors({
    origin: [process.env.CLIENT_DOMAIN],
    credentials: true,
    optionSuccessStatus: 200,
  })
)
app.use(express.json())

// JWT middleware
const verifyJWT = async (req, res, next) => {
  const token = req?.headers?.authorization?.split(' ')[1]
  console.log(token)
  if (!token) return res.status(401).send({ message: 'Unauthorized Access!' })
  try {
    const decoded = await admin.auth().verifyIdToken(token)
    req.tokenEmail = decoded.email
    console.log(decoded)
    next()
  } catch (err) {
    console.log(err)
    return res.status(401).send({ message: 'Unauthorized Access!', err })
  }
}

// Create a MongoClient
const client = new MongoClient(process.env.MONGODB_URI, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  },
})

async function run() {
  try {
    const db = client.db('clubSphere')
    const clubCollection = db.collection('clubs')
    const bookingCollection = db.collection('bookings')
    const usersCollection = db.collection('users')

    // Add new club
    app.post('/clubs', async (req, res) => {
      try {
        const clubData = req.body
        const result = await clubCollection.insertOne(clubData)
        res.send(result)
      } catch (error) {
        console.error('Error adding club:', error)
        res.status(500).send({ error: error.message })
      }
    })

    // Get all clubs
    app.get('/clubs', async (req, res) => {
      try {
        const result = await clubCollection.find().toArray()
        console.log('📋 Fetched clubs:', result.length)
        res.send(result)
      } catch (error) {
        console.error('Error fetching clubs:', error)
        res.status(500).send({ error: error.message })
      }
    })

    // Get single club by ID
    app.get('/clubs/:id', async (req, res) => {
      try {
        const id = req.params.id
        const result = await clubCollection.findOne({ _id: new ObjectId(id) })
        res.send(result)
      } catch (error) {
        console.error('Error fetching club:', error)
        res.status(500).send({ error: error.message })
      }
    })

    // Create checkout session
    app.post('/create-checkout-session', async (req, res) => {
      const paymentInfo = req.body
      console.log('Creating checkout session for:', paymentInfo)

      try {
        const session = await stripe.checkout.sessions.create({
          line_items: [
            {
              price_data: {
                currency: 'usd',
                product_data: {
                  name: paymentInfo?.name,
                  description: paymentInfo?.description,
                  images: [paymentInfo.image],
                },
                unit_amount: Math.round(paymentInfo?.price * 100),
              },
              quantity: paymentInfo?.quantity || 1,
            },
          ],
          customer_email: paymentInfo?.customer?.email,
          mode: 'payment',
          metadata: {
            clubId: paymentInfo?.clubId,
            customerEmail: paymentInfo?.customer?.email,
            customerName: paymentInfo?.customer?.name,
            customerImage: paymentInfo?.customer?.image || '',
            sellerEmail: paymentInfo?.seller?.email || '',
            sellerName: paymentInfo?.seller?.name || '',
            sellerImage: paymentInfo?.seller?.image || '',
          },
          success_url: `${process.env.CLIENT_DOMAIN}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${process.env.CLIENT_DOMAIN}/club/${paymentInfo?.clubId}`,
        })

        console.log('Checkout session created:', session.id)
        res.send({ url: session.url })
      } catch (error) {
        console.error('Stripe error:', error)
        res.status(500).send({ error: error.message })
      }
    })

    // Verify payment and create booking
    app.get('/verify-payment/:sessionId', async (req, res) => {
      const { sessionId } = req.params
      console.log('Verifying payment for session:', sessionId)

      try {
        // Retrieve the Stripe session
        const session = await stripe.checkout.sessions.retrieve(sessionId)
        console.log('Stripe session retrieved:', {
          id: session.id,
          payment_status: session.payment_status,
          metadata: session.metadata
        })

        if (session.payment_status === 'paid') {
          console.log('Payment confirmed as paid')

          // Check if booking already exists
          const existingBooking = await bookingCollection.findOne({
            sessionId: session.id
          })

          if (existingBooking) {
            console.log('Booking already exists:', existingBooking._id)
            return res.send({
              success: true,
              session,
              message: 'Booking already recorded',
              bookingId: existingBooking._id
            })
          }

          console.log('Creating new booking...')

          // Fetch club details
          const club = await clubCollection.findOne({
            _id: new ObjectId(session.metadata.clubId)
          })

          if (!club) {
            console.log('Club not found:', session.metadata.clubId)
            return res.status(404).send({ error: 'Club not found' })
          }

          console.log('Club found:', club.name)

          // Reconstruct seller object from metadata
          const seller = {
            email: session.metadata.sellerEmail || club.seller?.email,
            name: session.metadata.sellerName || club.seller?.name,
            image: session.metadata.sellerImage || club.seller?.image,
          }

          // Save booking to database
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
            seller: seller,
            name: club.name,
            category: club.category,
            quantity: 1,
            price: session.amount_total / 100,
            image: club.image,
            createdAt: new Date(),
          }

          console.log('Booking data prepared:', JSON.stringify(bookingData, null, 2))

          const result = await bookingCollection.insertOne(bookingData)
          console.log('Booking saved successfully! ID:', result.insertedId)

          res.send({
            success: true,
            session,
            bookingId: result.insertedId,
            message: 'Booking created successfully'
          })
        } else {
          console.log('Payment not completed. Status:', session.payment_status)
          res.send({
            success: false,
            session,
            message: 'Payment not completed'
          })
        }
      } catch (error) {
        console.error('Payment verification error:', error)
        res.status(500).send({ error: error.message })
      }
    })

    // Get customer orders
    app.get('/my-orders/:email', async (req, res) => {
      try {
        const email = req.params.email
        console.log('Fetching orders for customer:', email)

        const result = await bookingCollection
          .find({ 'customer.email': email })
          .toArray()

        console.log('Found customer orders:', result.length)
        res.send(result)
      } catch (error) {
        console.error('Error fetching customer orders:', error)
        res.status(500).send({ error: error.message })
      }
    })

    // Get seller orders
    app.get('/manage-orders/:email', async (req, res) => {
      try {
        const email = req.params.email
        console.log('Fetching orders for seller:', email)

        const result = await bookingCollection
          .find({ 'seller.email': email })
          .toArray()

        console.log('Found seller orders:', result.length)
        console.log('Orders data:', JSON.stringify(result, null, 2))

        res.status(200).send(result)
      } catch (error) {
        console.error('Error fetching seller orders:', error)
        res.status(500).send({ error: error.message })
      }
    })

    // Get User Inventory
    app.get('/my-inventory/:email', async (req, res) => {
      try {
        const email = req.params.email
        console.log('🔍 Fetching inventory for user:', email)

        const result = await clubCollection
          .find({ 'seller.email': email })
          .toArray()

        console.log('📦 Found clubs in inventory:', result.length)
        res.send(result)
      } catch (error) {
        console.error('❌ Error fetching inventory:', error)
        res.status(500).send({ error: error.message })
      }
    })

    // Add this endpoint to your backend (inside the run() function, after other routes)

    // Cancel/Delete order
    app.delete('/orders/:id', async (req, res) => {
      try {
        const id = req.params.id
        console.log('Cancelling order:', id)

        // First check if order exists
        const order = await bookingCollection.findOne({ _id: new ObjectId(id) })

        if (!order) {
          return res.status(404).send({ error: 'Order not found' })
        }

        // Check if order is already completed
        if (order.status === 'completed') {
          return res.status(400).send({ error: 'Cannot cancel completed orders' })
        }

        // Update order status to cancelled instead of deleting
        const result = await bookingCollection.updateOne(
          { _id: new ObjectId(id) },
          {
            $set: {
              status: 'cancelled',
              cancelledAt: new Date()
            }
          }
        )

        console.log('Order cancelled successfully:', id)
        res.send({ success: true, message: 'Order cancelled successfully' })
      } catch (error) {
        console.error('Error cancelling order:', error)
        res.status(500).send({ error: error.message })
      }
    })

    // Add this endpoint to your backend (inside the run() function, after other routes)

    // Cancel/Delete order (Customer)
    app.delete('/orders/:id', async (req, res) => {
      try {
        const id = req.params.id
        console.log('Cancelling order:', id)

        // First check if order exists
        const order = await bookingCollection.findOne({ _id: new ObjectId(id) })

        if (!order) {
          return res.status(404).send({ error: 'Order not found' })
        }

        // Check if order is already completed
        if (order.status === 'completed') {
          return res.status(400).send({ error: 'Cannot cancel completed orders' })
        }

        // Update order status to cancelled instead of deleting
        const result = await bookingCollection.updateOne(
          { _id: new ObjectId(id) },
          {
            $set: {
              status: 'cancelled',
              cancelledAt: new Date()
            }
          }
        )

        console.log('Order cancelled successfully:', id)
        res.send({ success: true, message: 'Order cancelled successfully' })
      } catch (error) {
        console.error('Error cancelling order:', error)
        res.status(500).send({ error: error.message })
      }
    })

    // Update order status (Seller)
    app.patch('/orders/:id', async (req, res) => {
      try {
        const id = req.params.id
        const { status } = req.body
        console.log('Updating order status:', id, 'to', status)

        // Validate status
        const validStatuses = ['confirmed', 'processing', 'completed', 'cancelled']
        if (!validStatuses.includes(status)) {
          return res.status(400).send({ error: 'Invalid status value' })
        }

        // Check if order exists
        const order = await bookingCollection.findOne({ _id: new ObjectId(id) })

        if (!order) {
          return res.status(404).send({ error: 'Order not found' })
        }

        // Update order status
        const updateData = {
          status,
          updatedAt: new Date()
        }

        // Add completion timestamp if status is completed
        if (status === 'completed') {
          updateData.completedAt = new Date()
        }

        const result = await bookingCollection.updateOne(
          { _id: new ObjectId(id) },
          { $set: updateData }
        )

        console.log('Order status updated successfully:', id)
        res.send({ success: true, message: 'Order status updated successfully' })
      } catch (error) {
        console.error('Error updating order status:', error)
        res.status(500).send({ error: error.message })
      }
    })
    // Add these endpoints to your backend (inside the run() function, after other club routes)

    // Update club
    app.patch('/clubs/:id', async (req, res) => {
      try {
        const id = req.params.id
        const clubData = req.body
        console.log('Updating club:', id)

        // Remove _id from update data if present
        delete clubData._id

        // Check if club exists
        const existingClub = await clubCollection.findOne({ _id: new ObjectId(id) })

        if (!existingClub) {
          return res.status(404).send({ error: 'Club not found' })
        }

        // Update club
        const result = await clubCollection.updateOne(
          { _id: new ObjectId(id) },
          {
            $set: {
              ...clubData,
              updatedAt: new Date()
            }
          }
        )

        if (result.modifiedCount === 0) {
          return res.status(400).send({ error: 'No changes made to club' })
        }

        console.log('Club updated successfully:', id)
        res.send({ success: true, message: 'Club updated successfully' })
      } catch (error) {
        console.error('Error updating club:', error)
        res.status(500).send({ error: error.message })
      }
    })

    // Delete club
    app.delete('/clubs/:id', async (req, res) => {
      try {
        const id = req.params.id
        console.log('Deleting club:', id)

        // Check if club exists
        const club = await clubCollection.findOne({ _id: new ObjectId(id) })

        if (!club) {
          return res.status(404).send({ error: 'Club not found' })
        }

        // Check if there are any active bookings for this club
        const activeBookings = await bookingCollection.findOne({
          clubId: id,
          status: { $nin: ['cancelled', 'completed'] }
        })

        if (activeBookings) {
          return res.status(400).send({
            error: 'Cannot delete club with active bookings. Please complete or cancel all bookings first.'
          })
        }

        // Delete the club
        const result = await clubCollection.deleteOne({ _id: new ObjectId(id) })

        console.log('Club deleted successfully:', id)
        res.send({
          success: true,
          message: 'Club deleted successfully',
          deletedCount: result.deletedCount
        })
      } catch (error) {
        console.error('Error deleting club:', error)
        res.status(500).send({ error: error.message })
      }
    })

    // save or update a user in db
    app.post('/user', async (req, res) => {
      const userData = req.body
      userData.created_at = new Date().toISOString()
      userData.last_loggedIn = new Date().toISOString()
      userData.role = 'customer'

      const query = {
        email: userData.email,
      }

      const alreadyExists = await usersCollection.findOne(query)
      console.log('User Already Exists---> ', !!alreadyExists)

      if (alreadyExists) {
        console.log('Updating user info......')
        const result = await usersCollection.updateOne(query, {
          $set: {
            last_loggedIn: new Date().toISOString(),
          },
        })
        return res.send(result)
      }

      console.log('Saving new user info......')
      const result = await usersCollection.insertOne(userData)
      res.send(result)
    })

    // get a user's role
    app.get('/user/role', verifyJWT, async (req, res) => {
      const result = await usersCollection.findOne({ email: req.tokenEmail })
      res.send({ role: result?.role })
    })


    // Ping MongoDB
    await client.db('admin').command({ ping: 1 })
    console.log('✅ Pinged your deployment. You successfully connected to MongoDB!')
  } finally {
    // Keep connection open
  }
}

run().catch(console.dir)



app.get('/', (req, res) => {
  res.send('Hello from ClubSphere Server!')
})

app.listen(port, () => {
  console.log(`Server is running on port ${port}`)
})