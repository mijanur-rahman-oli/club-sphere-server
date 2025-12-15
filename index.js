const express = require('express')
require('dotenv').config();
const cors = require('cors')
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb')
const stripe = require('stripe')(process.env.STRIPE_SECRET_KEY)
const port = process.env.PORT || 3000
// const admin = require('firebase-admin')
// const decoded = Buffer.from(process.env.FB_SERVICE_KEY, 'base64').toString(
//   'utf-8'
// )
// const serviceAccount = JSON.parse(decoded)
// admin.initializeApp({
//   credential: admin.credential.cert(serviceAccount),
// })

const admin = require('firebase-admin');
const serviceAccount = require('./serviceAccountKey.json');

admin.initializeApp({
  credential: admin.credential.cert(serviceAccount)
});

const app = express()
// middleware
app.use(
  cors({
    origin: [process.env.CLIENT_DOMAIN],
    credentials: true,
    optionSuccessStatus: 200,
  })
)
app.use(express.json())

// jwt middlewares
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

// Create a MongoClient with a MongoClientOptions object to set the Stable API version
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

    // should be add verifyToken and other things
    app.post('/clubs', async (req, res) => {
      const clubData = req.body
      const result = await clubCollection.insertOne(clubData)
      res.send(result)
    })

    app.get('/clubs', async (req, res) => {
      const result = await clubCollection.find().toArray()
      res.send(result)
    })

    // get all plants from db
    app.get('/clubs/:id', async (req, res) => {
      const id = req.params.id
      const result = await clubCollection.findOne({ _id: new ObjectId(id) })
      res.send(result)
    })

    // UNCOMMENT AND ADD THIS - Payment checkout endpoint
    app.post('/create-checkout-session', async (req, res) => {
      const paymentInfo = req.body
      console.log(paymentInfo)

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
            sellerId: paymentInfo?.seller?.email || '',
          },
          success_url: `${process.env.CLIENT_DOMAIN}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
          cancel_url: `${process.env.CLIENT_DOMAIN}/club/${paymentInfo?.clubId}`,
        })

        res.send({ url: session.url })
      } catch (error) {
        console.error('Stripe error:', error)
        res.status(500).send({ error: error.message })
      }
    })

    // ADD THIS - Payment verification endpoint
// UPDATED - Payment checkout endpoint
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
        // Store seller info as strings (Stripe metadata only accepts strings)
        sellerEmail: paymentInfo?.seller?.email || '',
        sellerName: paymentInfo?.seller?.name || '',
        sellerImage: paymentInfo?.seller?.image || '',
      },
      success_url: `${process.env.CLIENT_DOMAIN}/payment-success?session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${process.env.CLIENT_DOMAIN}/club/${paymentInfo?.clubId}`,
    })

    console.log('✅ Checkout session created:', session.id)
    res.send({ url: session.url })
  } catch (error) {
    console.error('❌ Stripe error:', error)
    res.status(500).send({ error: error.message })
  }
})

// UPDATED - Payment verification endpoint
app.get('/verify-payment/:sessionId', async (req, res) => {
  const { sessionId } = req.params
  console.log('🔍 Verifying payment for session:', sessionId)

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
      console.log('Inserted into collection: bookings')

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
    console.error('Error stack:', error.stack)
    res.status(500).send({ error: error.message })
  }
})

app.get('/my-orders/:email', async (req, res) => {
  const email = req.params.email

  const result = await bookingCollection
    .find({ 'customer.email': email })
    .toArray()

  res.send(result)
})


    // Send a ping to confirm a successful connection
    await client.db('admin').command({ ping: 1 })
    console.log(
      'Pinged your deployment. You successfully connected to MongoDB!'
    )
  } finally {
    // Ensures that the client will close when you finish/error
  }
}
run().catch(console.dir)

app.get('/', (req, res) => {
  res.send('Hello from Server..')
})

app.listen(port, () => {
  console.log(`Server is running on port ${port}`)
})
