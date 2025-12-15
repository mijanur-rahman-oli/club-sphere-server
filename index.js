require('dotenv').config()
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
    const clubCollection= db.collection('clubs')

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
    app.get('/verify-payment/:sessionId', async (req, res) => {
      const { sessionId } = req.params
      
      try {
        const session = await stripe.checkout.sessions.retrieve(sessionId)
        
        if (session.payment_status === 'paid') {
          // Check if booking already exists
          const existingBooking = await bookingCollection.findOne({ 
            sessionId: session.id 
          })
          
          if (!existingBooking) {
            // Save booking to database
            const bookingData = {
              sessionId: session.id,
              clubId: session.metadata.clubId,
              customerEmail: session.metadata.customerEmail,
              customerName: session.metadata.customerName,
              amount: session.amount_total / 100,
              currency: session.currency,
              paymentStatus: session.payment_status,
              createdAt: new Date(),
            }
            
            await bookingCollection.insertOne(bookingData)
          }
          
          res.send({ success: true, session })
        } else {
          res.send({ success: false, session })
        }
      } catch (error) {
        console.error('Payment verification error:', error)
        res.status(500).send({ error: error.message })
      }
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
