const ADMIN_USERNAME = "admin";
const ADMIN_PASSWORD = "1234";


const express = require('express');
const app = express()
const port = 3000

const mongoose = require('mongoose');
const multer = require('multer');
const nodemailer = require('nodemailer');
const session = require('express-session');

const storage = multer.diskStorage({
    destination: function (req, file, cb) {
        cb(null, 'public/uploads/')
    },
    filename: function (req, file, cb) {
        cb(null, Date.now() + '-' + file.originalname)
    }
})

const upload = multer({ storage: storage });

const mailUser = process.env.GMAIL_USER;
const mailPassword = process.env.GMAIL_APP_PASSWORD;
const transport = mailUser && mailPassword
    ? nodemailer.createTransport({
        service: 'gmail',
        auth: {
            user: mailUser,
            pass: mailPassword
        },
        connectionTimeout: 10000,
        greetingTimeout: 10000,
        socketTimeout: 15000
    })
    : null;

async function main() {
    await mongoose.connect('mongodb://127.0.0.1:27017/bookstore');
}
main()
.then(() => {console.log('Connected to MongoDB')})
.catch(err => console.log(err));

const bookSchema = new mongoose.Schema({
    title: String,
    author: String,

    price: Number,
    category: String,
    image: String
})

const orderSchema = new mongoose.Schema({
    customerName: { type: String, required: true },
    phone: { type: String, required: true },
    address: { type: String, required: true },
    paymentMethod: {
        type: String,
        enum: ['Cash on Delivery'],
        default: 'Cash on Delivery',
        required: true
    },
    items: [{
        bookId: { type: mongoose.Schema.Types.ObjectId, ref: 'Book', required: true },
        title: { type: String, required: true },
        price: { type: Number, required: true },
        quantity: { type: Number, required: true, min: 1 }
    }],
    total: { type: Number, required: true, min: 0 },
    status: { type: String, default: 'Pending' }
}, { timestamps: true });


app.use(session({
    secret: 'bookstoresecret',
    resave: false,
    saveUninitialized: false,
}))
app.use(express.urlencoded({ extended: true }))
app.use(express.json({ limit: '10kb' }))

function isAdmin(req, res, next) {
    if(req.session.isAdmin) {
        next();
    } else {
        res.redirect('/admin/login?status=unauthorized');
    }
}

app.get('/admin/login', (req, res) => {
    res.render('adminlogin.ejs', { authStatus: req.query.status });
})
app.post('/admin/login', (req, res, next) => {
    const username = req.body.username;
    const password = req.body.password;

    if (username === ADMIN_USERNAME && password === ADMIN_PASSWORD) {
        req.session.isAdmin = true;
        req.session.save(error => {
            if (error) return next(error);
            res.redirect('/books?status=logged-in');
        });
    } else {
        res.redirect('/admin/login?status=invalid');
    }
});
app.get('/admin/logout', (req, res, next) => {
    req.session.destroy(error => {
        if (error) return next(error);
        res.redirect('/?status=logged-out');
    });
})

const Book = mongoose.model('Book', bookSchema);
const Order = mongoose.model('Order', orderSchema);



app.set("view engine", "ejs")
app.use(express.static('public'))


app.get('/', (req, res) => {
    res.render('home.ejs', { authStatus: req.query.status })
})

app.get('/about', (req, res) => {
    res.render('about.ejs')
})

app.get('/books', async (req, res) => {
    const books = await Book.find();
    res.render('books.ejs', {
        books,
        isAdmin: req.session.isAdmin === true,
        authStatus: req.query.status
    });
})

app.get('/cart', (req, res) => {
    res.render('cart.ejs');
});

app.post('/orders', async (req, res) => {
    const { customerName, phone, address, items } = req.body;
    const normalizedName = typeof customerName === 'string' ? customerName.trim() : '';
    const normalizedPhone = typeof phone === 'string' ? phone.trim() : '';
    const normalizedAddress = typeof address === 'string' ? address.trim() : '';

    if (!normalizedName || !normalizedPhone || !normalizedAddress) {
        return res.status(400).json({ error: 'Enter your name, phone number, and delivery address.' });
    }

    if (!Array.isArray(items) || items.length === 0 || items.length > 100) {
        return res.status(400).json({ error: 'Your cart is empty or contains too many different books.' });
    }

    const requestedQuantities = new Map();
    for (const item of items) {
        if (!item || !mongoose.isValidObjectId(item.id)
            || !Number.isInteger(item.quantity) || item.quantity < 1 || item.quantity > 99) {
            return res.status(400).json({ error: 'Your cart contains an invalid book or quantity. Please review your cart.' });
        }

        const id = String(item.id);
        const quantity = (requestedQuantities.get(id) || 0) + item.quantity;
        if (quantity > 99) {
            return res.status(400).json({ error: 'A book quantity cannot exceed 99.' });
        }
        requestedQuantities.set(id, quantity);
    }

    const books = await Book.find({ _id: { $in: [...requestedQuantities.keys()] } });
    if (books.length !== requestedQuantities.size) {
        return res.status(400).json({ error: 'One or more books are no longer available. Please refresh your cart.' });
    }
    if (books.some(book => !book.title || !Number.isFinite(book.price) || book.price < 0)) {
        return res.status(400).json({ error: 'A book in your cart has invalid details and cannot be ordered.' });
    }

    const orderItems = books.map(book => ({
        bookId: book._id,
        title: book.title,
        price: book.price,
        quantity: requestedQuantities.get(String(book._id))
    }));
    const total = orderItems.reduce((sum, item) => sum + item.price * item.quantity, 0);

    const order = await Order.create({
        customerName: normalizedName,
        phone: normalizedPhone,
        address: normalizedAddress,
        paymentMethod: 'Cash on Delivery',
        items: orderItems,
        total
    });

    res.status(201).json({
        orderId: order._id,
        total: order.total,
        message: 'Your order is confirmed. Please pay cash when it is delivered.'
    });
});

app.get('/books/new', isAdmin, (req, res) => {
    res.render('newbook', { formError: req.query.status === 'image-required' });
});

// app.post('/books',upload.single('img'),(req,res)=>{
//     console.log(req.body)
//     console.log(req.file)
// })

app.post('/books', isAdmin, upload.single('img'), async (req, res) => {
    if (!req.file) {
        return res.status(400).render('newbook', { formError: true });
    }

    const book = new Book({
        title: req.body.title,
        author: req.body.author,
        price: req.body.price,
        category: req.body.category,
        image: '/uploads/' + req.file.filename
    });

    await book.save();
    res.redirect('/books');
});

app.post('/books/delete/:id', isAdmin, async (req, res) => {
    const id = req.params.id;
    await Book.findByIdAndDelete(id);
    res.redirect('/books');
});

app.get('/books/edit/:id',isAdmin, async (req, res) => {
    const Id = req.params.id;
    const book = await Book.findById(Id);
    res.render('editbook', { book });
});
app.post('/books/edit/:id', isAdmin, upload.single('img'), async (req, res) => {
    const book = await Book.findById(req.params.id);

    if (req.body.title) book.title = req.body.title;
    if (req.body.author) book.author = req.body.author;
    if (req.body.price) book.price = req.body.price;
    if (req.body.category) book.category = req.body.category;

    if (req.file) {
        book.image = '/uploads/' + req.file.filename;
    }

    await book.save();
    res.redirect('/books');
});

app.get('/categories', async (req, res) => {
    const books = await Book.find();
    const categories = [...new Set(books.map(book => book.category))];
    res.render('categories.ejs', { books, categories, isAdmin: req.session.isAdmin === true });
});

app.get('/categories/:category', async (req, res) => {
    const category = req.params.category;
    const books = await Book.find({ category: category });

    const allBooks = await Book.find();
    const categories = [...new Set(allBooks.map(book => book.category))];
    res.render('categories.ejs', { books, categories, isAdmin: req.session.isAdmin === true });
});


app.get('/contact', (req, res) => {
    res.render('contact.ejs', { contactStatus: req.query.status });
})

app.post('/contact', async (req, res) => {
    const wantsJson = req.accepts('json') === 'json';
    const name = typeof req.body.name === 'string' ? req.body.name.trim() : '';
    const email = typeof req.body.email === 'string' ? req.body.email.trim() : '';
    const mobile = typeof req.body.mobile === 'string' ? req.body.mobile.trim() : '';
    const message = typeof req.body.message === 'string' ? req.body.message.trim() : '';

    if (!name || !email || !mobile || !message
        || name.length > 100 || email.length > 254 || mobile.length > 30 || message.length > 5000
        || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        const error = 'Please enter a valid name, email, phone number, and message.';
        return wantsJson
            ? res.status(400).json({ error })
            : res.redirect('/contact?status=invalid');
    }

    if (!transport) {
        const error = 'Contact email is not configured yet. Please try again later.';
        return wantsJson
            ? res.status(503).json({ error })
            : res.redirect('/contact?status=unavailable');
    }

    try {
        await transport.sendMail({
            from: mailUser,
            to: mailUser,
            replyTo: email,
            subject: 'New message from Bookholic contact form',
            text: `Name: ${name}\nEmail: ${email}\nPhone: ${mobile}\n\n${message}`
        });

        return wantsJson
            ? res.json({ message: 'Your message was sent successfully. Thank you for contacting us.' })
            : res.redirect('/contact?status=sent');
    } catch (error) {
        console.error('Unable to send contact form email:', error);
        return wantsJson
            ? res.status(502).json({ error: 'We could not send your message right now. Please try again shortly.' })
            : res.redirect('/contact?status=failed');
    }
});

app.listen(port, () => {
  console.log(`Example app listening on port ${port}`)
})