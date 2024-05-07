const express = require('express');
const app = express();
const { Op } = require('sequelize');
const jwt = require('jsonwebtoken');
const passport = require('passport')
const LocalStrategy = require('passport-local').Strategy;
const ExtractJwt = require('passport-jwt').ExtractJwt;
//const bcrypt = require('bcrypt');
const bcrypt = require('bcryptjs'); // <-- HEROKU.
const nodemailer = require('nodemailer');
const speakeasy = require('speakeasy');
const QRCode = require('qrcode');
const cors = require('cors');

//importar la configuracion de passport.
//const passportGoogleStrategy = require('./Passport')

//models: <-- falta revisar BannedToken y asegurarse de que no hayan bugs.
const User = require('./models/User');
const Product = require('./models/Product');
const Category = require('./models/Category');
const BannedToken = require('./models/BannedToken');
const Brand = require('./models/Brand');
const Review = require('./models/Review');
const Favorite = require('./models/Favorite');
const ReportedProduct = require('./models/ReportedProduct');
const DeletedUser = require('./models/DeletedUser');
const Order = require('./models/Order');

const sequelize = require('./db');
const models = require('./models/associations');
const crypto = require('crypto');
const PaymentHistory = require('./models/PaymentHistory');
const Shipping = require('./models/Shipping');
const { log } = require('console');

app.use(cors());
app.use(express.json());

// configuracion de nodeMailer
const nodemailerOptions = {
    service: 'gmail',
    auth: {
        user: 'oliver125125@gmail.com',
        pass: 'aiyp fvhl djxd rjny',
    }
};

async function initializeTransporter() {
    const testAccount = await nodemailer.createTestAccount();

    nodemailerOptions.auth.user = nodemailerOptions.auth.user;
    nodemailerOptions.auth.pass = nodemailerOptions.auth.pass;

    const transporter = nodemailer.createTransport(nodemailerOptions);

    return transporter;
};

async function sendMail(transporter, to, subject, message) {
    try {
        const info = await transporter.sendMail({
            from: nodemailerOptions.auth.user,
            to: to,
            subject: subject,
            text: message,
            html: `<p>${message}</p>`
        });
        console.log(`Message sent: ${info.messageId}`);
        console.log(`Preview URL: ${nodemailer.getTestMessageUrl(info)}`);
    } catch (error) {
        console.error(`Error sending email to ${to}: ${error}`);
        throw error;
    }
};

//2FA 
//middleware para ver revisar si es que usuario (un admin) tiene activado 2FA.
async function requireTwoFactorAuthentication(req, res, next) {
    // speakksy.generateSecret();
    // verificar si is_admin es TRUE en User model
    // si no lo es, entonces return next()

    //luego crear ruta para activar y desactviar
    // crear ruta para verificar codigo
    // este utiliza google authenticator
    const userId = req.user.userId
    try {
        const user = await User.findByPk(userId)
        if (userId && user.is_admin && user.two_factor_authentication) {
            // if user is admin then require them to verify their their otp
            // now ask for their otp
        } else {
            return next();
        }
    } catch (error) {

    }
};

// RUTA PARA DEBUGGING. utilizar otp_secret column
app.post('/verify', isAuthenticated, async (req, res) => {
    const { otp } = req.body;
    if (!otp) {
        return res.status(400).json('Faltan datos');
    }

    const userId = req.user.userId;
    try {
        const user = await User.findByPk(userId);
        if (!user) {
            return res.status(404).json('Usuario no encontrado');
        }

        const verified = speakeasy.totp.verify({
            secret: user.otp_secret, // va a vericar con la column otp_secret.
            encoding: 'base32',
            token: otp,
            window: 2
        });

        if (verified) {
            return res.json({ verified: true });
        } else {
            return res.status(400).json({ verified: false });
        }
    } catch (error) {
        console.error('Error verifying OTP:', error);
        res.status(500).json('Internal Server Error');
    }
});




// STRIPE TESTING:

// AGREAGR: <-- USUARIO DEBE TENER SHIPPING INFO O DE LO CONTRARIO NO PODRA COMPRAR NADA.
// LUEGO DE QUE LA COMPRA SEA EXITOSA, AGREGARLA A ORDER TABLE.

// ADD ORDER FUNCTIONALITY.

const stripe = require('stripe')('sk_test_51P7RX608Xe3eKAmZLRdLEZqVedzK4Cv6EJks2vZg0qpjIxobSBvDXFJPUJE4wumqsOSuU1FMxzEyWEsXTZnIJEU000Spkdfy3x');

// debe ir asociado a un usuario
app.post('/create-checkout-session', isAuthenticated, isUserBanned, async (req, res) => {
    const userId = req.user.userId;
    const products = req.body.products;
    const { nickname, reqShippingId } = req.body; // Rename shippingId to reqShippingId

    let transaction;
    let shippingId;
    let orderId;

    if (!reqShippingId) {
        return res.status(400).json('Debe entregar al menos un dato de envio (ID o nickname) de su direccion de envio')
    };

    try {
        // arreglar bug en el cual usuarios podian usar shippingId de otros usuarios.
        // tambien se puede agreagr where: {nickname: nickname} mas tarde.
        const userShippingInfo = await Shipping.findOne({ where: { userId: userId, shippingId: reqShippingId } });

        if (!userShippingInfo) {
            return res.status(400).json('Aun no tienes informacion de envio, o tu info de envio esta incorrecta.');
        };


        const shippingInfo = await Shipping.findOne({ where: { shippingId: reqShippingId } });
        if (!shippingInfo) {
            return res.status(404).json('No se encontró la información de envío especificada.');
        }


        shippingId = shippingInfo.shippingId;
        console.log(`USER SHIPPING ID: ${shippingId}`);


        transaction = await sequelize.transaction();

        const items = [];
        const outOfStockProducts = [];
        const paymentHistoryData = [];
        let totalAmount = 0;

        const newOrder = await Order.create({
            userId: userId,
            totalAmount: 0, // Initial total amount is 0
            paymentStatus: 'pending', // Assuming the initial status is pending
            shippingId: shippingId // Assigning the retrieved shippingId
        }, { transaction });

        for (const product of products) {
            const checkProductExists = await Product.findByPk(product.id);
            if (!checkProductExists) {
                await transaction.rollback();
                return res.status(404).json('Un producto en tu carrito no existe');
            }

            product.shippingId = shippingId;

            const productFromDB = await Product.findByPk(product.id, { transaction });

            if (!productFromDB) {
                await transaction.rollback();
                return res.status(400).json({ error: `Product with ID ${product.id} not found.` });
            }

            if (product.quantity > productFromDB.stock) {
                await transaction.rollback();
                outOfStockProducts.push(productFromDB.name);
                return res.status(400).json({ error: `Product ${productFromDB.product} is out of stock.`, outOfStock: true });
            }

            productFromDB.stock -= product.quantity;
            await productFromDB.save({ transaction });

            items.push({
                price_data: {
                    currency: 'usd',
                    product_data: {
                        name: productFromDB.product,
                        images: productFromDB.image ? [ productFromDB.image ] : [],
                    },
                    unit_amount: productFromDB.price * 100, // Stripe lo pone en centavos asi que se multiplica.
                },
                quantity: product.quantity
            });

            const subtotal = productFromDB.price * product.quantity;
            totalAmount += subtotal;


            orderId = newOrder.id; // Retrieve the generated orderId

            // Update paymentHistoryData with the correct orderId
            for (const data of paymentHistoryData) {
                data.orderId = orderId;
            }

            await newOrder.addProducts(productFromDB, { through: { quantity: product.quantity }, transaction }); // <-- FIX THIS LINE

            paymentHistoryData.push({
                userId: userId,
                productId: product.id,
                quantity: product.quantity,
                purchaseDate: new Date(),
                total_transaction_amount: subtotal,
                shippingId: shippingId,
                orderId: newOrder.id // <-- para que todos pertenezcan al mismo id de Orden. 
            });
        };

        newOrder.totalAmount = totalAmount;
        await newOrder.save({ transaction });

        await transaction.commit();

        const session = await stripe.checkout.sessions.create({
            payment_method_types: [ 'card' ],
            line_items: items,
            mode: 'payment',
            success_url: 'http://localhost:3000/paymenthistory',
            cancel_url: 'https://www.example.com/cancel',
        });

        await PaymentHistory.bulkCreate(paymentHistoryData);

        res.json({ id: session.id });
    } catch (error) {
        console.error('Error creating checkout session:', error);
        if (transaction) {
            await transaction.rollback();
        }
        res.status(500).json({ error: 'Internal server error' });
    }
});

// debugging route.                         <-----
app.get('/allorders', isAuthenticated, isAdmin, async (req, res) => {
    try {
        // Retrieve all orders along with associated user and product information
        const allOrders = await Order.findAll({
            include: [
                { model: User }, // Include the User model
                { model: Product } // <-- THIS IS MISSING ! 
            ]
        });

        res.json(allOrders); // Return the list of all orders with associated user and product information
    } catch (error) {
        console.error('Error retrieving all orders:', error);
        res.status(500).json({ error: 'Internal server error' }); // Return an error response if there's an error
    }
});

// UN USUARIO PUEDE VER TODO SU HISTORIAL DE ORDENES. 
app.get('/my-orders', isAuthenticated, isUserBanned, async (req, res) => {
    const userId = req.user.userId;

    try {
        const allUserOrders = await Order.findAll({
            where: {
                userId: userId
            },
            include: [ {
                model: Product
            }, {
                model: Shipping // Include the Shipping model here
            } ]
        });

        if (allUserOrders.length === 0) {
            return res.status(404).json('No tienes ningun historial de ordenes.')
        };

        res.json(allUserOrders);
    } catch (error) {
        res.status(500).json(`Internal Server error: ${error}`);
    }
});



// ver historial de pagos.
// esto tambien se usa para verificar que un usuario haya comprado el producto del cual deja una review.
app.get('/payment-history', isAuthenticated, isUserBanned, async (req, res) => {
    const userId = req.user.userId;

    try {
        const paymentDetails = await PaymentHistory.findAll({
            where: {
                userId: userId
            },
            include: [
                {
                    model: Shipping
                }
            ]
        });

        if (paymentDetails.length === 0) {
            return res.status(404).json('No has comprado nada.');
        }

        res.json(paymentDetails);
    } catch (error) {
        res.status(500).json(`Internal Server error: ${error}`);
    }
});





// ruta para que usuarios agreguen su informacion de envio.

//TENDRE QUE PERMITIR A USUARIOS PODER TENER VARIAS DIRECCIONES DE ENVIO ASOCIADAS A ELLOS.
app.post('/user/shipping', isAuthenticated, isUserBanned, async (req, res) => {
    const userId = req.user.userId;
    const { nickname, country, city, zip_code } = req.body;

    if (!country || !city || !zip_code) {
        return res.status(400).json('Faltan datos obligatorios');
    }

    // check that user cannot create an address with the same name TWICE

    try {
        // nickname deberia ser unico.
        const existingShipping = await Shipping.findOne({ where: { userId: userId, nickname: nickname } });
        if (existingShipping) {
            return res.status(400).json({ error: 'Ya tienes una dirección de envío con el mismo apodo.', nicknameAlreadyInUse: true });
        }

        const addressCount = await Shipping.count({ where: { userId: userId } });
        if (addressCount >= 10) {
            return res.status(400).json({ error: 'Has alcanzado el límite máximo de direcciones de envío (10).', maxShipping: true });
        }

        // Create new shipping address
        const newShippingInfo = await Shipping.create({
            userId,
            nickname,
            country,
            city,
            zip_code
        });

        res.status(201).json({ message: 'Información de envío agregada con éxito', details: newShippingInfo });

    } catch (error) {
        res.status(500).json(`Error interno del servidor: ${error}`);
    }
});


// ruta para que un usuario pueda ACTUALIZAR su info de envio.
app.put('/update-shipping-info', isAuthenticated, isUserBanned, async (req, res) => {
    const userId = req.user.userId;
    const { nickname, id, country, city, zip_code } = req.body;

    if (!id) {
        return res.status(400).json('Debe proporcionar el id de shipping a actualizar')
    };

    try {
        const userShippingInfo = await Shipping.findOne({
            where: {
                shippingId: id,
                userId: userId
            }
        }); // <-- encontrar la info que el usuario posee y evitar colisiones con info de otros usuarios.

        if (!userShippingInfo) {
            return res.status(404).json('No se encontró la información de envío para el usuario actual con el ID proporcionado.');
        }


        await userShippingInfo.update({
            country: country || userShippingInfo.country,
            city: city || userShippingInfo.city,
            zip_code: zip_code || userShippingInfo.zip_code
        });

        const updatedShippingInfo = await Shipping.findByPk(id);

        res.status(200).json({ message: 'Información de envío actualizada con éxito', details: updatedShippingInfo });


    } catch (error) {
        res.status(500).json(`Error interno del servidor: ${error}`);
    }
});


// ruta para que un usuario pueda ver su info de envio.
app.get('/shipping-info', isAuthenticated, isUserBanned, async (req, res) => {
    const userId = req.user.userId;

    try {

        const userShippingInfo = await Shipping.findAll({
            where: {
                userId: userId
            }
        });

        if (!userShippingInfo) {
            return res.status(404).json('Aun no tienes info de envio, intenta agregarla.')
        };

        res.json(userShippingInfo)

    } catch (error) {
        res.status(500).json(`Internal Server Error: ${error}`)
    }
});


// :END OF STRIPE TESTING 



//ruta para generar secret key. Se puede utilizar codigo para agregar manualmente en caso de no poder escanear QR.
app.get('/generate-secret', isAuthenticated, isAdmin, async (req, res) => {
    const userId = req.user.userId;

    try {

        const user = await User.findOne({ where: { id: userId } });
        if (user.otp_secret) { return res.status(400).json('Ya has creado tu secreto anteriormente.') };

        const secret = speakeasy.generateSecret();

        await user.update({ otp_secret: secret.base32 });

        res.json({ secret: secret.base32 });

    } catch (error) {
        res.status(500).json(`Internal Server Error: ${error.message}`);
    }
});

//generar codigo QR para agregarlo a la app.
app.post('/generate-qr-code', isAuthenticated, (req, res) => {
    const secret = req.body.secret;
    if (!secret) { return res.status(400).json('Faltan datos') };

    const otpAuthUrl = speakeasy.otpauthURL({ secret, label: 'MyApp' });
    QRCode.toDataURL(otpAuthUrl, (error, imageUrl) => {
        if (error) {
            res.status(500).send('Error generating QR code');
        } else {
            res.send(`<img src="${imageUrl}" alt="QR Code">`);
        }
    })
});

//ruta para que usuarios admin puedan activar 2FA.
app.put('/2fa/activate', isAuthenticated, isAdmin, async (req, res) => {
    const userId = req.user.userId;

    try {
        const user = await User.findByPk(userId);
        if (!user) { return res.status(404).json('No existe usuario') }; // el usuario deberia existir siempre.
        if (user && user.two_factor_authentication) {
            return res.status(400).json('Ya tienes 2FA activado')
        } else {
            await user.update({
                two_factor_authentication: true // <-- Esto luego se debe utilizar para requerir a los usuarios ingrear su OTP.
            })
        };
        res.json('2FA activado con exito')

    } catch (error) {
        res.status(500).json(`Internal Server Error: ${error}`);
    }
});


function isAuthenticated(req, res, next) {
    const token = req.headers.authorization && req.headers.authorization.split(' ')[ 1 ]; // extrae el token de los headers.
    if (!token) {
        return res.status(401).json({ message: 'No token provided.' });
    }

    //  if (isTokenBanned(token)) {
    //      return res.status(403).json({ message: 'Token has been banned' });
    //  }

    jwt.verify(token, 'access-secret', (error, decoded) => {
        if (error) {
            return res.status(401).json({ message: 'Invalid access token.' });
        }
        req.user = decoded;
        next();
    });
};

// Middleware to check for admin privileges
async function isAdmin(req, res, next) {
    const userId = req.user.userId;
    try {
        const user = await User.findByPk(userId);
        if (user && user.is_admin) {
            next();
        } else {
            res.status(403).json('You are not an admin, cannot access this route.');
        }
    } catch (error) {
        console.error('Error checking admin privileges:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
};

//to generate reset token for forgotten password.
function generateToken() {
    return crypto.randomBytes(20).toString('hex');
    const expirationDate = Date.now() + (10 * 60 * 1000);
    return { token, expirationDate }
};

// ESTO NO TIENE EFECTO EN USUARIOS DE GOOGLE.
// function must also send a token/code with an exp date so that certain users can access this page/route to reset password.
app.post('/reset-password-request', isAuthenticated, isUserBanned, async (req, res) => {
    const { email } = req.body;

    if (!email) {
        return res.status(400).json({ message: 'Missing email' });
    }

    try {
        const user = await User.findOne({ where: { email } });

        if (!user) {
            return res.status(404).json({ message: 'User not found.' });
        }

        const resetToken = generateToken();
        const tokenExpiration = new Date();
        tokenExpiration.setHours(tokenExpiration.getHours() + 1); // Expires in 1 hour

        await user.update({ password_reset_token: resetToken, password_reset_token_expires: tokenExpiration });

        const transporter = await initializeTransporter();
        const subject = 'password reset'

        await sendMail(transporter, email, subject, resetToken);

        console.log(`Reset token sent to user with email: ${email}`);
        console.log(`reset token: ${resetToken}`);

        return res.status(200).json({ resetToken, expirationDate: tokenExpiration });
    } catch (error) {
        console.error('Error resetting password:', error);
        return res.status(500).json({ error: 'Internal Server Error' });
    }
});


// NO TIENE EFECTO EN USUARIOS DE GOOGLE.
// this route must verify the code so that only users who requested a password reset can access it. 
app.post('/reset-password', isAuthenticated, isUserBanned, async (req, res) => {
    const userId = req.user.userId;
    const resetToken = req.body.resetToken;

    const newPassword = req.body.newPassword;
    const confirmNewPassword = req.body.confirmNewPassword;

    if (!resetToken) {
        return res.status(400).json({ message: 'Missing reset token' });
    }

    try {
        const user = await User.findByPk(userId);

        if (!user) {
            return res.status(404).json({ message: 'User not found.' });
        }

        if (user.password_reset_token !== resetToken || user.password_reset_token_expires < new Date()) {
            return res.status(400).json({ message: 'Invalid or expired reset token.' });
        }

        if (!newPassword || !confirmNewPassword || newPassword !== confirmNewPassword) {
            return res.status(400).json({ message: 'Credentials must be provided and must also match.' });
        }

        const hashedPassword = await bcrypt.hash(newPassword, 10);
        await user.update({ password: hashedPassword, password_reset_token: null, password_reset_token_expires: null });

        return res.status(200).json({ message: 'Password reset successful.' });
    } catch (error) {
        console.error('Error resetting password:', error);
        return res.status(500).json({ error: 'Internal server error' });
    }
});



app.put('/users/grant-admin/:id', isAuthenticated, async (req, res) => { // debe utilizar isAdmin luego de que exista el primer admin.
    const id = req.params.id;
    if (!id) {
        return res.status(400).json('Must provide an id');
    };

    if (req.user.is_admin) { return res.json('User is already an admin') }; // <- this line never triggers.

    try {
        const user = await User.findByPk(id);
        if (!user) {
            return res.status(404).json({ message: 'User not found.' });
        }

        await user.update({ is_admin: true });

        res.json({ message: `User ${user.username} has been granted admin privileges.` });
    } catch (error) {
        console.error('Error granting admin privileges:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ruta para que un admin pueda ver todos los datos de un usuario especifico
app.get('/users/info/details/:username', isAuthenticated, isAdmin, async (req, res) => {
    const username = req.params.username;
    if (!username) { return res.status(400).json('Debe incluir el nombre de usuario a buscar.') };

    try {
        const userDetails = await User.findOne({
            where: { username: username }
        });
        if (!username) { return res.status(404).json(`Usuario: ${username} no encontrado`) };

        res.json(userDetails)

    } catch (error) {
        res.status(500).json(`Internal Server Error: ${error}`)
    }
});

app.get('/user-details/:id', isAuthenticated, isAdmin, async (req, res) => {
    const id = req.params.id;
    if (!id) {
        return res.status(400).json({ error: 'Falta id', idNotProvided: true });
    };

    try {

        const userDetails = await User.findByPk(id);
        if (!userDetails) {
            return res.status(404).json({ error: `Usuario con id: ${id} no existe`, userNotFound: true });
        };

        res.json(userDetails)

    } catch (error) {
        res.status(500).json({ error: 'Internal Server Error', error });
    }

});


async function isTokenBanned(token) {
    const bannedToken = await BannedToken.findOne({ where: { token: token } });
    return bannedToken ? true : false
};

//middleware to check against banned tokens before giving a new one.
async function checkBannedToken(req, res, next) {
    const refreshToken = req.body.refreshToken;
    const accessToken = req.body.accessToken;

    if (refreshToken) {
        const isRefreshTokenBanned = await isTokenBanned(refreshToken);
        if (isRefreshTokenBanned) {
            return res.status(403).json({ message: 'Refresh token is banned.' });
        }
    }

    if (accessToken) {
        const isAccessTokenBanned = await isTokenBanned(accessToken);
        if (isAccessTokenBanned) {
            return res.status(403).json({ message: 'Access token is banned.' });
        }
    }

    next();
}; // <-- las unicas rutas que pueden entregar tokens son /login & /access-token .


// automaticamente poder generar nuevo accessToken en el lado del cliente.
// ruta actualizada: si un token se encuentra baneado, se seguira generando hasta entregar uno que sea unico. 
// si se intenta banear un token que ya esta en BannedToken, entonces no lo insertara y seguira generando hasta entregar uno 
// el cual sea unico, y entregara ese al usuario al final de la ejecucion.
// todo esto arreglo el bug de 'duplicate entry' que existia antes.
app.post('/access-token', async (req, res) => {
    const refreshToken = req.body.refreshToken; // Usuario entrega refreshToken como evidencia.

    const allBannedTokens = await BannedToken.findAll(); // <-- to make sure the newly ban token is not banned before insertion.

    if (!refreshToken) {
        return res.status(401).json({ message: 'No refresh token provided.' });
    }

    if (await isTokenBanned(refreshToken)) {
        const bannedTokens = await BannedToken.findAll();

        jwt.verify(refreshToken, 'refresh-secret', async (error, decoded) => {
            if (error) {
                console.log(`Error verificando refreshToken: ${error}`);
                return res.status(401).json({ message: 'Invalid refresh token.' });
            }

            let accessToken;
            // Generar nuevo token hasta entregar uno no baneado.
            do {
                accessToken = jwt.sign({ userId: decoded.userId, username: decoded.username }, 'access-secret', { expiresIn: '50m' });
            } while (bannedTokens.some((token) => token.token === accessToken));

            // luego de entregarlo, banearlo
            // EL token que sera baneado no debe estar ya incluido en la base de datos, para evitar duplicate entry error.
            const checkIsTokenBanned = await BannedToken.findOne({
                where: { token: accessToken }
            });

            if (!checkIsTokenBanned) {
                BannedToken.create({ token: accessToken })
                    .then(() => {
                        res.json({ accessToken });
                    })
                    .catch((error) => {
                        console.error('Error adding access token to banned tokens:', error);
                        res.status(500).json({ message: 'Internal server error' });
                    });
            } else {
                console.log('Newly generated access token is already banned. Generating a new one...');
                // If the newly generated token is already banned, recursively call the function to generate a new one
                return generateNewAccessToken(res, decoded);
            }
        });
    } else {
        jwt.verify(refreshToken, 'refresh-secret', (error, decoded) => {
            if (error) {
                console.error('Error verifying refresh token:', error); // Debugging 
                return res.status(401).json({ message: 'Invalid refresh token.' });
            }

            console.log('Decoded:', decoded); // Debugging

            const accessToken = jwt.sign({ userId: decoded.userId, username: decoded.username }, 'access-secret', { expiresIn: '50m' });

            console.log('New Access Token:', accessToken); // Debugging 


            BannedToken.create({ token: accessToken })
                .then(() => {

                    res.json({ accessToken });
                })
                .catch((error) => {
                    console.error('Error adding access token to banned tokens:', error);
                    res.status(500).json({ message: 'Internal server error' });
                });
        });
    }
});

// Helper function to generate a new access token recursively
// esta funcion NO esta en uso.
async function generateNewAccessToken(res, decoded) {
    const accessToken = jwt.sign({ userId: decoded.userId, username: decoded.username }, 'access-secret', { expiresIn: '50m' });

    try {
        // Store the new access token
        await BannedToken.create({ token: accessToken });
        // Send the new access token
        res.json({ accessToken });
    } catch (error) {
        console.error('Error adding access token to banned tokens:', error);
        res.status(500).json({ message: 'Internal server error' });
    }
};



app.get('/test/admin', isAuthenticated, isAdmin, (req, res) => {
    res.json('you are an admin')
});

// loggearse
app.post('/login', async (req, res) => { // FALTA AGREGAR: SI USUARIO ES ADMIN Y TIENE 2FA ACTIVADO ENTONCES REQUERIR OTP.
    const username = req.body.username;  // tambien se puede solicitar otp para eliminar usuario, producto, etc.
    const password = req.body.password;

    try {
        //revisar el blacklist DeletedUser
        const blackListedUsername = await DeletedUser.findOne({ where: { username } });
        if (blackListedUsername) {
            return res.status(403).json({ message: 'Error, Tu cuenta ha sido eliminada.', userHasBeenDeleted: true });
        };

        const user = await User.findOne({ where: { username } });
        if (!user) {
            return res.status(404).json({ message: `Username ${username} Not Found` });
        }

        const passwordMatch = await bcrypt.compare(password, user.password);
        if (!passwordMatch) {
            return res.status(401).json({ message: 'Invalid username or password.', invalidCredentials: true });
        }

        // Generate new tokens
        const accessToken = jwt.sign({ userId: user.id, username: user.username }, 'access-secret', { expiresIn: '50m' });
        const refreshToken = jwt.sign({ userId: user.id, username: user.username }, 'refresh-secret', { expiresIn: '15d' });

        res.json({ message: 'Login successful', accessToken, refreshToken });
    } catch (error) {
        console.log(error);
        return res.status(500).json({ message: 'Internal Server Error.' });
    }
});

//LOGOUT ROUTE. Falta arreglar
app.post('/logout', isAuthenticated, async (req, res) => {
    const accessToken = req.headers.authorization && req.headers.authorization.split(' ')[ 1 ]; // Extract access token
    const refreshToken = req.body.refreshToken;

    console.log(`Access Token: ${accessToken}`);
    console.log(`Refresh Token: ${refreshToken}`);

    try {
        if (!refreshToken) {
            return res.status(400).json('Debe incluir refresh token');
        }


        jwt.verify(refreshToken, 'refresh-secret', async (error, decoded) => {
            if (error) {
                return res.status(401).json({ message: 'Invalid refresh token.' });
            }


            await BannedToken.create({ token: accessToken });
            await BannedToken.create({ token: refreshToken });


            res.json({ logOutSuccessful: true, message: 'Logout successful' });
        });
    } catch (error) {
        return res.status(500).json({ error: 'Internal server error', error });
    }
});

// ruta actualizada: incluye email e email de bienvenida enviado automaticamente, tambien regex para confirmar email.
// username and email must both be unique
app.post('/signup', async (req, res) => {

    const { firstName, lastName, username, confirmUsername, email, confirmEmail, password, confirmPassword } = req.body;

    if (!firstName || !lastName || !username || !confirmUsername || !email || !confirmEmail || !password || !confirmPassword) {
        return res.status(400).json('Missing data');
    };

    const emailRegex = /^[\w-]+(?:\.[\w-]+)*@(?:[\w-]+\.)+[a-zA-Z]{2,7}$/;
    if (!email || !email.match(emailRegex)) {
        return res.status(400).json(`Formato de email incorrecto`);
    };


    try {
        // revisar contra el blacklist de DeletedUser.

        const blackListedUsername = await DeletedUser.findOne({ where: { username } });
        const blackListedEmail = await DeletedUser.findOne({ where: { email } });
        if (blackListedUsername || blackListedEmail) {
            return res.status(403).json({ forbiddenMessage: 'Tu cuenta ya ha sido eliminada' });
        };

        const checkUserExists = await User.findOne({ where: { username: username } });
        if (checkUserExists) {
            return res.status(400).json({
                message: `Username: ${username} already exists`,
                usernameAlreadyExists: true
            });
        }
        const checkEmailExists = await User.findOne({ where: { email: email } });
        if (checkEmailExists) {
            return res.status(400).json({
                message: `Email: ${email} already have an account`,
                emailAlreadyExists: true
            });
        }


        if (username === confirmUsername && email === confirmEmail && password === confirmPassword) {
            const hashedPassword = await bcrypt.hash(password, 10)
            const newUser = await User.create({ first_name: firstName, last_name: lastName, username, email, password: hashedPassword });

            // SEND WELCOME EMAIL HERE.
            const transporter = await initializeTransporter();
            await sendMail(transporter, email, 'Bienvenido a nuestro sitio', 'Gracias por registrarte');
            console.log(`Email sent to new user: ${email}`);
            return res.status(201).json(`Username: ${newUser.username} created successfully`);

        } else {
            res.status(400).json({ message: 'fields must match' })
        }
    } catch (error) {
        res.status(500).json(`Internal Server Error: ${error.message}`);
    }
});
// EDIT PROFILE:

app.put('/profile/edit', async (req, res) => {
    const { id, firstName, lastName, username, email, password, image } = req.body;

    if (!id) {
        return res.status(400).json('Missing user id');
    };

    try {
        const user = await User.findOne({ where: { id } });
        if (!user) {
            return res.status(404).json('User not found');
        }

        if (firstName) user.first_name = firstName;
        if (lastName) user.last_name = lastName;
        if (username) user.username = username;
        if (email) user.email = email;
        // if (image) user.image = image;
        if (password) {
            const hashedPassword = await bcrypt.hash(password, 10);
            user.password = hashedPassword;
        }

        await user.save();

        return res.status(200).json(`User: ${user.username} updated successfully`);
    } catch (error) {
        res.status(500).json(`Internal Server Error: ${error.message}`);
    }
});

// PROFILE:
app.get('/profile-info', isAuthenticated, isUserBanned, async (req, res) => {
    const userId = req.user.userId;
    try {
        const userProfileData = await User.findOne({
            where: {
                id: userId
            },
            attributes: { exclude: [ 'password', 'otp_secret', 'password_reset_token', 'password_reset_token_expires', 'id', 'google_id' ] },
            include: [
                {
                    model: Shipping,
                    attributes: { exclude: [ 'id', 'userId', 'createdAt', 'updatedAt' ] }
                }
            ]
        });
        // aqui no se envian ciertos valores por motivos de seguridad.
        res.json(userProfileData)

    } catch (error) {
        res.status(500).json(`Internal Server Error: ${error}`)
    }
});

// ruta para crear review, un usuario solamente puede escribir una review de un producto una vez.
// se verifica que el usuario haya comprado el producto antes de poder escribir una review.
app.post('/review', isAuthenticated, isUserBanned, async (req, res) => {
    const userId = req.user.userId;
    const { productId, review, rating } = req.body; // <-- AGREGAR RATING.

    console.log(`User id: ${userId}`); // array de palabras que no sigan las guias

    if (!review) {
        return res.status(400).json('Debe incluir una review');
    }

    if (!rating) {
        return res.status(400).json('Falta incluir rating.')
    };

    // el rating debe ser entre 1 y 5, tambien se puede tener 3.2, 4.5, etc.
    if (!/^(\d+(\.\d+)?)$/.test(rating) || rating < 1 || rating > 5) {
        return res.status(400).json('El rating debe ser un número entre 1 y 5.');
    }

    if (!productId) {
        return res.status(400).json('Debe incluir un id de producto');
    }
    if (!/^\d+$/.test(productId)) {
        return res.status(400).json('El id de producto debe ser un número.');
    }

    try {
        const existingReview = await Review.findOne({
            where: { productId, userId }
        });
        if (existingReview) {
            return res.status(400).json('Ya has escrito una review para este producto.');
        }

        const product = await Product.findByPk(productId);
        if (!product) {
            return res.status(404).json('Id de producto no encontrado.');
        }

        // revisar que el usuario haya adquirido el producto antes de que pueda dejar una review del mismo.
        const purchaseRecord = await PaymentHistory.findOne({
            where: {
                userId: userId,
                productId: productId
            }
        });

        if (!purchaseRecord) { return res.status(400).json(`Debes comprar el producto con id: ${productId} antes de poder dejar una review.`) };

        const createdReview = await Review.create({ productId, userId, review, rating });
        res.status(201).json({ message: 'Review creada con éxito', review: createdReview });
    } catch (error) {
        res.status(500).json(`Error interno del servidor: ${error}`);
    }
});

//ruta para que un usuario pueda eliminar su review escrita sobre un producto especifico (por productId)
app.delete('/review/:reviewId', isAuthenticated, isUserBanned, async (req, res) => {
    const userId = req.user.userId;
    const reviewId = req.params.reviewId; // <-- deja la reviewId y esa review sera eliminada (si es que tu usuario la ha escrito).

    if (reviewId) { return res.status(400).json('Debe incluir reviewId') }

    try {
        const reviewToDelete = await Review.findOne({ where: { id: reviewId, userId } });

        if (!reviewToDelete) {
            return res.status(404).json('Review not found or you are not authorized to delete it');
        }

        await reviewToDelete.destroy();
        res.json('Review deleted successfully');
    } catch (error) {
        res.status(500).json(`Internal Server Error: ${error}`);
    }
});


///ruta para ver todas las reviews que un usuario ha escrito. un usuario solo puede dejar una review por producto. 
app.get('/user/reviews', isAuthenticated, isUserBanned, async (req, res) => {
    const userId = req.user.userId;
    console.log(`User id: ${userId}`);

    try {
        const productsWithReviews = await Product.findAll({
            include: [
                {
                    model: Review,
                    where: { userId },
                    include: {
                        model: User,
                        attributes: [ 'id', 'username' ]
                    }
                }
            ]
        });
        // console.log('Products with Reviews:', productsWithReviews); 

        res.json({ resultado: productsWithReviews.length, productsWithReviews });
    } catch (error) {
        console.error('Error fetching products with reviews:', error);
        res.status(500).json(`Internal Server Error: ${error}`);
    }
});


// debugging route. <-- works.
app.get('/reviews', async (req, res) => {
    try {
        const reviews = await Product.findAll({
            include: [
                { model: Review, include: User }
            ]
        });
        res.json({ resultado: reviews.length, reviews });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// debugging route to get the right amount of reviews per user id.
app.get('/my-reviews', isAuthenticated, isUserBanned, async (req, res) => {
    const userId = req.user.userId;
    console.log(`user id: ${userId}`);

    try {
        const allReviews = await Review.findAll({
            where: { userId: userId },
            attributes: { exclude: [ 'userId' ] } // <-- usuario no pueden ver su ID. 
        });
        if (allReviews.length === 0) { return res.status(404).json('No reviews available') };
        res.json({ reviewCount: allReviews.length, allReviews })
    } catch (error) {
        res.status(500).json(`Internal Server Error: ${error.message}`)
    }
});

//ruta para crear brands.
app.post('/brand', isAuthenticated, isAdmin, async (req, res) => {
    const brandName = req.body.brandName;
    if (!brandName) { return res.status(400).json('Missing brand name'); }
    if (brandName.length > 50) { return res.status(400).json(`Brand name is too long: ${brandName}`); }

    try {
        const existingBrand = await Brand.findOne({ where: { brand: brandName } }); // <-- cada marca es Unica.
        if (existingBrand) {
            return res.status(400).json(`Brand: ${brandName} already exists`);
        } else {
            await Brand.create({ brand: brandName });
            return res.status(201).json(`Brand: ${brandName} created successfully`);
        }
    } catch (error) {
        res.status(500).json(`Internal Server Error: ${error}`);
    }
});

// ver todas las marcas disponibles
app.get('/allbrands', async (req, res) => {
    try {
        const allBrands = await Brand.findAll();
        if (allBrands.length === 0) { return res.status(404).json('There are no brands.') }
        res.json(allBrands)
    } catch (error) {
        res.status(500).json(`Internal Server Error: ${error}`)
    }
});

// buscar marca por id
app.get('/brand/:id', async (req, res) => {
    const { id } = req.params;
    if (!id) { return res.status(400).json('Missing brand id') };

    try {
        const item = await Product.findAll({ where: { brandId: id } })
        if (item.length === 0) { return res.status(404).json(`No se encontraron productos con brand id: ${id}`) }
        res.json(item)
    } catch (error) {
        res.json(error)
    }
});

//buscar producto por su nombre de marca
app.get('/product/:brand', async (req, res) => {
    const brandName = req.params.brand;
    if (!brandName) {
        return res.status(400).json('Missing brand name');
    }
    try {
        const products = await Brand.findAll({
            where: { brand: brandName },
        });
        if (products.length === 0) {
            return res.status(404).json(`No hay productos con la marca: ${brandName}`);
        }
        return res.json(products);
    } catch (error) {
        return res.status(500).json(`Internal Server Error: ${error.message}`);
    }
});


//crear producto, una vez agregado TODOS los usuarios reciben un email.
app.post('/product', isAuthenticated, isAdmin, async (req, res) => {
    try {
        const {
            brandId,
            product,
            stock,
            price,
            description,
            tags,
            attributes,
            salePrice,
            featured,
            // IMAGE    <-- 
            image, // added
            categoryNames
        } = req.body;

        const userId = req.user.userId; // Extract userId from the decoded JWT token
        // no se debe agregar review al producto a la hora de crearlo, esa es tarea de los usuarios.
        // check that brandId exists.

        // revisar si el producto ya existe
        const checkProductExists = await Product.findOne({
            where: { product: product }
        });
        if (checkProductExists) { return res.status(400).json(`El producto con nombre: ${product} ya existe`) };

        // Create the product with the provided attributes and userId
        const createdProduct = await Product.create({
            brandId,
            product,
            stock,
            price,
            description,
            tags,
            attributes,
            salePrice,
            featured,
            image, // added
            userId // Include userId
        });

        // revisar si id de marca existe. 
        // si es que no existe, se puede dar un error o crearla de una vez.

        if (categoryNames && categoryNames.length > 0) {
            const categories = await Promise.all(categoryNames.map(async (categoryData) => {
                // Find or create category by name
                let category = await Category.findOne({ where: { category: categoryData.name } });
                if (!category) {
                    category = await Category.create({ category: categoryData.name, description: categoryData.description });
                }
                return category;
            }));
            await createdProduct.addCategories(categories);
        }

        //SEND EMAIL. Al crear un producto TODOS los usuarios recibiran un correo con el nombre del nuevo producto agreagdo.
        const transporter = await initializeTransporter();
        const users = await User.findAll();
        for (const user of users) {
            if (user.email) {
                const userEmail = user.email;
                await sendMail(transporter, userEmail,
                    `Hemos agregado un nuevo producto`, `Que tal? te escribimos porque hemos agregado un nuevo producto a la 
                tienda, ya disponible para adquirir ! ${createdProduct.product}`);
            }
        }


        res.status(201).json({ message: `Product added successfully`, product: createdProduct });
    } catch (error) {
        res.status(500).json({ error: `Internal Server Error: ${error}` });
    }
});

// ACTUALIZAR PRODUCTO EXISTENTE. Hasta ahora funciona.
app.put('/update-product/:productId', isAuthenticated, isAdmin, async (req, res) => {
    const userId = req.user.userId;
    const productId = req.params.productId;
    const {
        brandId,
        product,
        stock,
        price,
        description,
        //brand,
        tags,
        attributes,
        featured,
        categoryNames
    } = req.body;

    try {
        const existingProduct = await Product.findOne({ where: { id: productId } }) // o findByPk.
        if (!existingProduct) {
            return res.status(404).json({ message: `Product with ID ${productId} not found` });
        }

        // si no pasan nada, seguiran tal cual como estaban.
        const updatedProduct = await existingProduct.update({
            brandId: brandId || existingProduct.brandId,
            product: product || existingProduct.product,
            stock: stock || existingProduct.stock,
            price: price || existingProduct.price,
            description: description || existingProduct.description,
            // brand: brand || existingProduct.brand,
            tags: tags || existingProduct.tags,
            attributes: attributes || existingProduct.attributes,
            featured: featured || existingProduct.featured
        });

        // en caso de ingresar categorias. 
        if (categoryNames && categoryNames.length > 0) {
            const categories = await Promise.all(categoryNames.map(async (categoryData) => {
                let category = await Category.findOne({ where: { category: categoryData.name } });
                if (!category) {
                    category = await Category.create({ category: categoryData.name, description: categoryData.description });
                }
                return category;
            }));
            await updatedProduct.setCategories(categories);
        }

        res.json({ message: `Product with ID ${productId} updated successfully`, product: updatedProduct });
    } catch (error) {
        res.status(500).json({ error: `Internal Server Error: ${error.message}` });
    }
});

// se utiliza en UpdateProduct Component. 
app.get('/product-detail/:id', async (req, res) => {
    const id = req.params.id;
    if (!id) {
        return res.status(400).json({ id: false, message: 'Debe incluir id de producto' });
    }

    try {
        const productDetail = await Product.findOne({
            where: { id: id },
            include: [
                Category,
                Brand,
                {
                    model: Review,
                    include: [
                        User // Include the User model associated with Review
                    ]
                }
            ]
        });

        if (!productDetail) {
            return res.status(404).json({ productFound: false, message: `Producto con id: ${id} no encontrado` });
        }

        res.json(productDetail);
    } catch (error) {
        res.status(500).json(`Internal Server Error: ${error}`);
    }
});



//REPORTES: 


//ruta para que usuarios puedan reportar un producto. (por id). Un usuario puede reportar un producto una sola vez.
app.post('/products/report/id', isAuthenticated, isUserBanned, async (req, res) => {
    const userId = req.user.userId;
    const productId = req.body.productId;
    if (!productId) { return res.status(400).json('Debe uncluir el id del producto') };

    console.log(`User id: ${userId}`);

    try {
        // first check if product exists.
        const existingProduct = await Product.findByPk(productId);
        if (!existingProduct) { return res.status(404).json(`No existe el producto con id: ${productId}`) };

        const existingReport = await ReportedProduct.findOne({
            where: {
                productId: productId,
                userId: userId
            }
        });
        if (existingReport) { return res.status(400).json(`Ya has reportado este producto. con id: ${productId}`) };

        const newReport = await ReportedProduct.create({
            productId,
            userId
        });

        res.status(201).json(`Producto con id: ${productId} reportado con exito`);

    } catch (error) {
        res.status(500).json(`Internal Server Error: ${error}`);
    }
});

//ruta para que usuarios puedan reportar un producto. (por nombre)
app.post('/products/report/name', isAuthenticated, isUserBanned, async (req, res) => {
    const userId = req.user.userId;
    const productName = req.body.productName;
    if (!productName) { return res.status(400).json('Debe incluir el nombre del producto') };

    console.log(`User id: ${userId}`);

    try {
        const existingProduct = await Product.findOne({
            where: { product: productName }
        });
        if (!existingProduct) { return res.status(404).json({ message: `Producto ${productName} no existe`, productNotExists: true }) };

        const existingReport = await ReportedProduct.findOne({
            where: {
                productId: existingProduct.id,
                userId: userId
            }
        });
        if (existingReport) { return res.status(400).json(`Ya has reportado este producto con nombre: ${productName}`) };

        const newReport = await ReportedProduct.create({
            productId: existingProduct.id,
            userId
        });
        res.status(201).json(`Producto con nombre: ${productName} reportado con exito`);

    } catch (error) {
        res.status(500).json(`Internal Server Error: ${error}`);
    }
});

// obtener TODOS los productos
app.get('/allproducts', async (req, res) => {
    try {
        const allProducts = await Product.findAll({
            include: [
                { model: Category },
                { model: Brand },
                {
                    model: Review,
                    include: {
                        model: User,
                        attributes: [ 'username' ] // <-- para ver quien escribio la review de cada producto
                    }
                }
            ]
        });


        if (allProducts.length > 0) {
            res.json(allProducts);
        } else {
            return res.status(404).json('There are no products available');
        }
    } catch (error) {
        res.status(500).json(`Internal Server Error: ${error}`);
    }
});

// FILTRAR POR CATEGORIA.
app.get('/category/:name', async (req, res) => {
    const name = req.params.name;
    if (!name || name.length > 90) { return res.status(400).json('Introduzca una categoria valida') };

    try {
        const products = await Category.findAll({
            include: Product,
            where: { category: name }
        });
        if (products.length === 0) { return res.status(404).json(`No existe categoria: ${name}`) };
        res.json(products)
    } catch (error) {
        res.status(500).json(`Internal Server Error: ${error}`)
    }
});

app.get('/category', async (req, res) => {
    // const name = req.params.name;
    // if (!name || name.length > 90) {return res.status(400).json('Introduzca una categoria valida')};

    try {
        const products = await Category.findAll({
            include: Product,
        });
        res.json(products)
    } catch (error) {
        res.status(500).json(`Internal Server Error: ${error}`)
    }
});

app.get('/searchproduct/:productname', async (req, res) => {
    const productname = req.params.productname;
    if (!productname) { return res.status(400).json('Missing product name') };
    if (productname.length > 50) { return res.status(400).json('Product name is too long') };

    try {
        const products = await Product.findAll({
            where: { product: { [Op.iLike]: '%' + productname + '%' } }, // Busca coincidencias en cualquier parte del nombre
            include: [ Category ] // Include associated categories
        });

        if (products && products.length > 0) {
            res.json(products);

        } else {
            res.status(404).json(`No products with name: ${productname}`);
        };
    } catch (error) {
        res.status(500).json(`Internal Server Error: ${error}`);
    }
})
app.get('/allusers', isAuthenticated, isAdmin, async (req, res) => {
    try {
        const allUsers = await User.findAll({
            //     include: Order
        });
        if (allUsers && allUsers.length > 0) {
            return res.json({ message: 'All users:', users: allUsers });
        } else {
            return res.status(404).json({ message: 'No users found.' });
        }
    } catch (error) {
        return res.status(500).json({ message: `Internal Server Error: ${error}` });
    }
});



// admin puede eliminar usuario por su id.
app.delete('/deleteuser/id/:id', isAuthenticated, isAdmin, async (req, res) => {
    const id = req.params.id;
    if (!id) {
        return res.status(400).json('Falta id');
    }

    try {
        const userToDelete = await User.findByPk(id);
        if (!userToDelete) {
            return res.status(404).json({
                message: `No user with ID: ${id} was found.`,
                noUserIdFound: true
            });

        } else {

            await Order.destroy({ where: { userId: userToDelete.id } });
            await PaymentHistory.destroy({ where: { userId: userToDelete.id } });
            // estas 2 deletions arreglaron el error a la hora de eliminar un usuario con records/
            // en las tablas PaymentHistory y Order.

            // user username y user email
            const userEmailToBan = userToDelete.email;
            const userUsernameToBan = userToDelete.username;
            // agregarlos a DeletedUser.
            await DeletedUser.create({ userId: userToDelete, username: userUsernameToBan, email: userEmailToBan });

            await userToDelete.destroy();

            //AGREGAR EMAIL
            const transporter = await initializeTransporter();
            await sendMail(transporter, userToDelete.email, 'Tu cuenta ha sido eliminada',
                'Te escribimos para informarte que debido a no hbaer seguido nuestras reglas, hemos tenido que dar tu cuenta de baja');

            return res.status(201).json(`Usuario con ID: ${id} eliminado con exito`);
        }
    } catch (error) {
        console.log(error);
        res.status(500).json(`Internal Server Error: ${error}`);
    }
});

// cuando un usuario es eliminado, deberian recibir un email incluyendo la razon de su eliminacion.

// admin puede eliminar usuario por su username (unico)
app.delete('/deleteuser/:username', isAuthenticated, isAdmin, async (req, res) => { // testeada y FUNCIONA.
    const username = req.params.username;
    if (!username) {
        return res.status(400).json('Debe incluir un nombre de usuario');
    }
    if (username.length > 90) {
        return res.status(400).json('Debe incluir un nombre de usuario valido');
    }

    try {

        const userToDelete = await User.findOne({ where: { username } });
        if (!userToDelete) {
            return res.status(404).json(`No se ha encontrado el usuario: ${username}`);

        } else {


            // debugging
            await Order.destroy({ where: { userId: userToDelete.id } });
            await PaymentHistory.destroy({ where: { userId: userToDelete.id } });
            // estas 2 deletions arreglaron el error a la hora de eliminar un usuario con records/
            // en las tablas PaymentHistory y Order.


            const userIdToBan = userToDelete.id;
            const userEmailToBan = userToDelete.email;

            await DeletedUser.create({ userId: userIdToBan, username, email: userEmailToBan });

            await userToDelete.destroy();

            // AGREGAR EMAIL

            const transporter = await initializeTransporter();
            await sendMail(transporter, userToDelete.email, 'Tu cuenta ha sido eliminada',
                'Te escribimos para informarte que debido a no hbaer seguido nuestras reglas, hemos tenido que dar tu cuenta de baja');

            return res.status(201).json(`Usuario: ${username} eliminado con exito`);
        }
    } catch (error) {
        res.status(500).json(`Internal Server Error: ${error}`);
    }
});



// admin puede eliminar usuario por su email (unico)
app.delete('/deleteuser/email/:email', isAuthenticated, isAdmin, async (req, res) => {
    const email = req.params.email;
    if (!email) { return res.status(400).json('Debe incluir email de usuario a eliminar') };
    const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
    if (!emailRegex.test(email)) { return res.status(400).json('Email invalido.') };

    try {
        const userToDelete = await User.findOne({
            where: { email }
        });
        if (userToDelete) {

            await Order.destroy({ where: { userId: userToDelete.id } });
            await PaymentHistory.destroy({ where: { userId: userToDelete.id } });
            // estas 2 deletions arreglaron el error a la hora de eliminar un usuario con records/
            // en las tablas PaymentHistory y Order.

            // user id
            const userIdToBan = userToDelete.id;
            const userUsernameToBan = userToDelete.username;

            // si el usuario se encuntra entonces agregarlo a DeletedUser.
            await DeletedUser.create({ userId: userIdToBan, username: userUsernameToBan, email });

            await User.destroy({
                where: { email }
            });

            //SEND EMAIL.
            const transporter = await initializeTransporter();
            await sendMail(transporter, email, 'Tu cuenta ha sido eliminada',
                'Te escribimos para informarte que debido a no haber seguido nuestras reglas, tu cuenta ha sido eliminada.');

            return res.status(201).json(`Usuario con email: ${email} eliminado con exito`);
        } else {
            return res.status(404).json(`No se ha encontrado un usuario con el email: ${email}`);
        }
    } catch (error) {
        res.status(500).json(`Internal Server Error: ${error}`);
    }
});

// ruta para que un usuario puede eliminar SU PROPIA CUENTA.    
app.delete('/delete/user', isAuthenticated, isUserBanned, async (req, res) => {
    const userId = req.user.userId;
    // esta no necesita ser baneada ya que el usuario no ha roto las reglas, simplemente ha decidido dejar el sitio de manera permanente.
    try {
        await User.destroy({
            where: {
                id: userId
            }
        });
        res.status(200).json('Tu cuente ha sido eliminada con exito.');
    } catch (error) {
        res.status(500).json({ error: `Internal Server Error: ${error.message}` });
    }
});


// ruta para productos en orden alfabetico
app.get('/products/alphorder', async (req, res) => {
    try {
        const allProducts = await Product.findAll({
            order: [
                [ 'product', 'ASC' ]
            ]
        });

        if (allProducts.length > 0) {
            res.json(allProducts);
        } else {
            return res.status(404).json('No hay productos disponibles');
        }

    } catch (error) {
        res.status(500).json(`Internal Server Error: ${error}`)
    }
});

// ruta para buscar producto especifico por su nombre. 
// Route to search for a specific product by its name.
app.get('/search/product/:name', async (req, res) => {
    const name = req.params.name;
    if (!name || name.length > 90) {
        return res.status(400).json('Please provide a valid product name');
    }

    try {
        const products = await Product.findAll({
            include: [ Category, Brand, Review ], // Incluye todos los modelos.
            where: {
                product: name
            }
        });

        if (products.length === 0) {
            return res.status(404).json(`No products found with the name: ${name}`);
        }

        res.json({ resultCount: products.length, products: products });
    } catch (error) {
        res.status(500).json(`Internal Server Error: ${error}`);
    }
});


//ruta para buscar por precio mayor a: x
app.get('/searchbypricebigger/:price', async (req, res) => {
    const price = req.params.price;
    if (!price) {
        return res.status(400).json('Falta el precio');
    }
    if (isNaN(price)) {
        return res.status(400).json('Debe ser un precio valido');
    }

    try {
        const products = await Product.findAll({
            include: Category, Brand,
            where: {
                price: {
                    [ Op.gt ]: price
                }
            }
        });
        if (products.length === 0) {
            return res.status(404).json(`No se encontraron productos mayor a el precio: ${price}`);
        }

        res.json({ resultado: products.length, products: products });
    } catch (error) {
        return res.status(500).json(`Internal Server Error: ${error}`);
    }
});


//ruta para buscar por precio menor a: x
app.get('/searchbypriceless/:price', async (req, res) => {
    const price = req.params.price;
    if (!price) {
        return res.status(400).json('Falta el precio');
    }
    if (isNaN(price)) {
        return res.status(400).json('Debe ser un precio valido');
    }

    try {
        const products = await Product.findAll({
            include: Category, Brand,
            where: {
                price: {
                    [ Op.lt ]: price
                }
            }
        });
        if (products.length === 0) {
            return res.status(404).json(`No se encontraron productos menor a el precio: ${price}`);
        }

        res.json({ resultado: products.length, products: products });
    } catch (error) {
        return res.status(500).json(`Internal Server Error: ${error}`);
    }
});

// this route returns all of the products ordered by price.
app.get('/searchbyprice/asc', async (req, res) => {
    try {
        const products = await Product.findAll({
            order: [ [ 'price', 'ASC' ] ]
        });

        if (products.length === 0) {
            return res.status(404).json({ error: 'No se encontraron productos', productNotFound: true });
        };

        res.json({ resultado: products.length, products: products });

    } catch (error) {
        return res.status(500).json(`Internal Server Error: ${error}`);
    }
});

// most expensive to cheaper
app.get('/searchbyprice/desc', async (req, res) => {

    try {

        const products = await Product.findAll({
            order: [ [ 'price', 'DESC' ] ]
        });

        if (products.length === 0) {
            return res.status(404).json({ error: 'No existen productos', productNotFound: true })
        };

        res.json(products);

    } catch (error) {
        res.status(500).json(`Internal Server Error: ${error}`);
    }

});


app.get('/all-deleted-users', isAuthenticated, isAdmin, async (req, res) => {
    try {

        const allBannedUsers = await DeletedUser.findAll();

        if (allBannedUsers.length === 0) {
            return res.status(404).json('No se han encontrado usuarios eliminados');
        };
        res.json(allBannedUsers);

    } catch (error) {
        res.status(500).json(`Internal Server Error: ${error}`)
    }
});


//ruta para buscar por rango de precio entre: y x
app.get('/searchbypricerange/:start/:end', async (req, res) => {
    const start = req.params.start;
    const end = req.params.end;

    if (isNaN(start) || isNaN(end)) {
        return res.status(400).json('Deben ser numeros');
    }

    try {

        const products = await Product.findAll({
            include: Category, Brand, // <-- falta: Description, Review.
            where: {
                price: {
                    [ Op.between ]: [ start, end ]
                }
            }
        });

        if (products.length === 0) {
            return res.status(404).json(`No se han econtrado productos con el rango de precio: ${start} y ${end}`)
        }

        res.json({ resultados: `${products.length}`, products });
    } catch (error) {
        res.status(500).json({ error: `Internal Server Error: ${error.message}` });
    }
});


// ruta para combinar muchos filtros.

// when an admin deletes a product, users should know. nodeMailer
app.delete('/product/:id', isAuthenticated, isAdmin, async (req, res) => {
    const id = req.params.id;

    if (!id) {
        return res.status(400).json('Falta id.');
    }

    try {

        const product = await Product.findByPk(id);
        if (!product) {
            return res.status(404).json(`No hay producto con id: ${id}`);
        };

        // delete Favorite associations.
        await Favorite.destroy({ where: { productId: id } });

        // revisar si el producto ha sido reportado.
        // si es que lo ha sido, entonces eliminar todos los reportes antes de eliminar el producto.
        const reports = await ReportedProduct.findAll({
            where: {
                productId: id
            }
        });

        if (reports.length > 0) {
            for (const report of reports) {
                const reportId = report.id;
                const reportProductId = report.productId;

                await report.destroy();
            }
        }

        console.log(`REPORTED PRODUCT INFO FROM CONSOLE.LOG: ${reports} and PRODUCT ID: ${id}`);

        // eliminar los reportes, arregla el error de: CONTRAINT: ReportedProducs references id Products.

        const productName = product.product;

        const transporter = await initializeTransporter();


        const users = await User.findAll();


        for (const user of users) {
            if (user.email) {
                const userEmail = user.email;
                await sendMail(transporter, userEmail, 'Producto Eliminado', `El producto "${productName}" ha sido eliminado.`);
            } else {
                console.log(`No se pudo enviar el correo electrónico a ${user.id} porque no tiene una dirección de correo electrónico válida.`);
            }
        }

        await Product.destroy({ where: { id: id } });

        res.json(`Producto con id: ${id} eliminado con éxito`);
    } catch (error) {
        console.error('Error al eliminar el producto y notificar a los usuarios:', error);
        res.status(500).json(`Internal Server Error: ${error}`);
    }
});

// ELIMINAR PRODUCTO POR SU NOMBRE (case sensitive).
app.delete('/product/delete/name', isAuthenticated, isAdmin, async (req, res) => {
    const userId = req.user.userId;
    const productName = req.body.productName;

    if (!productName) {
        return res.status(400).json('Debe incluir el nombre del producto a eliminar');
    }

    try {
        const productToDelete = await Product.findOne({
            where: { product: productName }
        });
        if (!productToDelete) { return res.status(404).json({ message: `no existo producto con nombre: ${productName}`, productNotFound: true }) };

        await Product.destroy({ where: { product: productName } });

        res.json({ message: `Producto con nombre ${productName} eliminado comn exito`, productDeleted: true });
    } catch (error) {
        res.status(500).json(`Internal Server Error: ${error}`);
    }
});

// ruta para que admins puedan enviar email masivos a todos los usuarios registrados.
app.post('/send-email-to-all-users', isAuthenticated, isAdmin, async (req, res) => {
    const { subject, message } = req.body;
    if (!subject || !message) {
        return res.status(400).json('Faltan datos');
    }

    try {

        const allUserEmails = await User.findAll();

        if (allUserEmails.length === 0) {
            return res.status(404).json('No hay correos disponibles');
        }

        const transporter = await initializeTransporter();

        for (const user of allUserEmails) {
            if (user.email) {
                const userEmail = user.email; // Extract email address from user object
                await sendMail(transporter, userEmail, subject, message);
            }
        };

        res.json('Emails enviados con exito');

    } catch (error) {
        console.error('Error sending emails:', error);
        res.status(500).json('Internal Server Error');
    }
});


//rutas de favorites: 

//ruta para ver todos los favoritos que el usuario especifico tiene en su lista.
app.get('/products/user/favorites', isAuthenticated, isUserBanned, async (req, res) => {
    const userId = req.user.userId; // <-- for each user specific data.

    try {
        const allFavorites = await Favorite.findAll({ where: { userId }, include: [ Product ] });
        if (allFavorites.length === 0) {
            return res.status(404).json('No se han encontrado favoritos, intenta agregar uno.');
        } else {
            res.json({ total: allFavorites.length, favorites: allFavorites });
        }
    } catch (error) {
        console.error('Error fetching favorites:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});



// ruta para anadir producto a su favorito (usuario).
app.post('/products/user/favorites', isAuthenticated, isUserBanned, async (req, res) => {
    const userId = req.user.userId;
    const { productId } = req.body;

    try {

        const product = await Product.findByPk(productId);
        if (!product) {
            return res.status(404).json(`Product with id: ${productId} does not exist.`);
        }

        const existingFavorite = await Favorite.findOne({ where: { userId, productId } });
        if (existingFavorite) {
            return res.status(400).json({ error: `Product with id ${productId} already in favorites.`, productAlreadyAddedToFavorites: true });
        }

        await Favorite.create({ userId, productId });
        res.json(`Product with id: ${productId} successfully added to favorites.`);

    } catch (error) {
        console.error('Error adding product to favorites:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// ruta para eliminar un favorito por id.
app.delete('/products/user/favorites', isAuthenticated, isUserBanned, async (req, res) => {
    const userId = req.user.userId;
    const { productId } = req.body;

    try {
        const product = await Product.findByPk(productId);
        if (!product) {
            return res.status(404).json(`Product with id: ${productId} does not exist.`);
        }

        const existingFavorite = await Favorite.findOne({ where: { userId, productId } });
        if (!existingFavorite) {
            return res.status(400).json({ error: `Product with id ${productId} is not in favorites.`, productNotInFavorites: true });
        }

        await existingFavorite.destroy();
        res.json(`Product with id: ${productId} successfully removed from favorites.`);

    } catch (error) {
        console.error('Error removing product from favorites:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});


// ruta para cambiar un producto de su categoria a otra. <-- falta verificar que funcione.
app.put('/update-product-category', isAuthenticated, isAdmin, async (req, res) => {
    const userId = req.user.userId;
    const categoryNames = req.body.categoryNames;
    const productId = req.body.productId;

    if (!categoryNames || categoryNames.length === 0) { // se debe pasar un array por json ya que pueden ser varias categorias.
        return res.status(400).json('Falta categorías');
    }
    if (!productId) {
        return res.status(400).json('Falta ID de producto');
    }

    try {
        const product = await Product.findByPk(productId);
        if (!product) {
            return res.status(404).json({ error: `Producto con ID: ${productId} no encontrado` });
        }

        for (const category of categoryNames) {
            const categoryName = category.name;
            const categoryDescription = category.description;

            // si es que la nueva categoria no existe, entonces sera creada automaticamente.
            let existingCategory = await Category.findOne({ where: { category: categoryName } });
            if (!existingCategory) {
                existingCategory = await Category.create({ category: categoryName, description: categoryDescription });
            }

            // Associate the product with the category by ID
            await product.addCategory(existingCategory.id);
        }

        res.status(200).json({ success: true, message: 'Categorías actualizadas exitosamente' });
    } catch (error) {
        res.status(500).json(`${error}`);
    }
});

// ruta para que admin pueda crear un usuario manualmente.


// ruta para que un admin pueda eliminar un producto de una categoria.

// ruta para que un admin pueda ver todos los productos reportados y luego decidir si eliminarlos o no.
app.get('/products/reported', isAuthenticated, isAdmin, async (req, res) => {
    const userId = req.user.userId;

    try {
        const allReportedProducts = await ReportedProduct.findAll({
            include: [ { model: User }, { model: Product } ] // Include the users who reported the product and the reviews
        });

        if (allReportedProducts.length === 0) {
            return res.status(404).json('No reported products currently exist');
        }

        res.json({ totalReports: allReportedProducts.length, result: allReportedProducts });

    } catch (error) {
        res.status(500).json(`Internal Server Error: ${error}`);
    }
});


// Ruta de filtros COMBINADOS.
app.get('/products/filter/:start/:end/:startRating/:endRating/:category/:brand', async (req, res) => {
    const { start, end, startRating, endRating, category, brand } = req.params;

    if (!start && !end && !startRating && !endRating && !category && !brand) {
        return res.status(400).json('Debe incluir por lo menos 1 filtro');
    }

    // Regex.
    const numberRegex = /^\d+(\.\d+)?$/;
    if (!numberRegex.test(start) || !numberRegex.test(end) || !numberRegex.test(startRating) || !numberRegex.test(endRating)) {
        return res.status(400).json('Los valores de inicio, fin y calificación deben ser números o decimales.');
    }

    try {
        let filter = {
            price: {
                [ Op.between ]: [ start, end ]
            }
        };

        if (category) {
            filter[ '$categories.category$' ] = category;
        }

        if (brand) {
            filter[ '$brand.brand$' ] = brand;
        }

        const filteredProducts = await Product.findAll({
            where: filter,
            include: [
                {
                    model: Category,
                    attributes: [], // se puede excluir lo que quieras
                    through: { attributes: [] }, // aqui tambien
                },
                {
                    model: Review,
                    where: {
                        rating: {
                            [ Op.between ]: [ startRating, endRating ]
                        }
                    }
                },
                {
                    model: Brand,
                    attributes: [] // y aqui.
                }
            ]
        });

        console.log('FILTERED PRODUCTS:', filteredProducts);

        if (filteredProducts.length === 0) {
            return res.status(404).json('No existen productos con los filtros aplicados');
        }

        res.json(filteredProducts);

    } catch (error) {
        console.error('Error filtering products:', error);
        res.status(500).json({ error: 'Internal Server Error' });
    }
});

// MIDDLEWARE PARA USUARIOS BANEADOS.
async function isUserBanned(req, res, next) {
    try {
        const userId = req.user.userId;
        const user = await User.findByPk(userId);

        if (!user) {
            return res.status(400).json('Usuario no encontrado');
        }

        if (user.banned && user.ban_expiration && new Date() > new Date(user.ban_expiration)) {
            user.banned = false;
            user.ban_expiration = null;
            await user.save();
        }

        if (user.banned) {
            return res.status(403).json({ error: 'Tu cuenta aún está baneada' });
        }

        // If user is not banned, proceed to the next middleware or route handler
        next();
    } catch (error) {
        console.error("Error checking ban status:", error);
        res.status(500).json(`Internal Server Error: ${error}`);
    }
};




// MIDDLEWARE PARA USUARIOS BANEADOS.
async function isUserBanned(req, res, next) {
    try {
        const userId = req.user.userId;
        const user = await User.findByPk(userId);

        if (!user) {
            return res.status(400).json('Usuario no encontrado');
        }

        if (user.banned && user.ban_expiration && new Date() > new Date(user.ban_expiration)) {
            user.banned = false;
            user.ban_expiration = null;
            await user.save();
        }

        if (user.banned) {
            return res.status(403).json({ error: 'Tu cuenta aún está baneada' });
        }

        // If user is not banned, proceed to the next middleware or route handler
        next();
    } catch (error) {
        console.error("Error checking ban status:", error);
        res.status(500).json(`Internal Server Error: ${error}`);
    }
};




// ruta para que un admin pueda banear a un usuario (en horas). falta comprobar que FUNCIONE.
app.post('/ban/:userId', isAuthenticated, isAdmin, async (req, res) => {
    const userId = req.params.userId;
    const banDurationHours = req.body.banDurationHours;

    if (!userId || !banDurationHours) {
        return res.status(400).json('Faltan datos obligatorios')
    };

    // revisar que usuario a banear no sea admin, ni tampoco el mismo que esta accediendo a esta ruta.
    const checkUser = await User.findOne({
        where: {
            id: userId
        }
    }); // <-- will always be found thanks to isAuthenticated

    if (!checkUser) {
        return res.status(404).json({ error: 'No existe el usuario ingresado', userNotFound: true })
    };


    // check if user is trying to ban an admin or himself.
    if (checkUser.is_admin || checkUser.id === userId) {
        return res.status(400).json({ error: 'No puedes banear a otro usuario Admin ni a ti mismo.', invalidBan: true });
    };

    try {
        const user = await User.findByPk(userId)
        if (!user) { return res.status(404).json(`Usuario con id: ${userId} no existe`) };

        const banExpiration = new Date();
        banExpiration.setMinutes(banExpiration.getMinutes() + (banDurationHours * 60)); // Convert hours to minutes

        await user.update({
            banned: true,
            ban_expiration: banExpiration // Update the ban expiration time
        });

        return res.json(`Usuario con id: ${userId} baneado por ${banDurationHours} horas.`);

    } catch (error) {
        res.status(500).json(`Internal Server Error: ${error}`)
    }
}); // <-- solo falta comprobar que el ban haya sido levantado.

// ruta para que un admin pueda ver todos los usuarios baneados.
app.get('/all-banned-users', isAuthenticated, isAdmin, async (req, res) => {

    try {

        const allBannedUsers = await User.findAll({
            where: {
                banned: true,
                ban_expiration: {
                    [ Op.not ]: null
                }
            }
        });

        if (allBannedUsers.length === 0) { return res.status(404).json('No hay usuarios baneados.') };

        const filteredBannedUsers = allBannedUsers.filter(user => user.ban_expiration && new Date() < new Date(user.ban_expiration));

        res.json({
            result: allBannedUsers.length,
            users: filteredBannedUsers
        });

    } catch (error) {
        res.status(500).json(`Internal Server Error: ${error}`);

    }
});

//ruta para que un admin manualmente pueda eliminar el ban.
app.put('/ban/remove/:userId', isAuthenticated, isAdmin, async (req, res) => { })

app.get('/test/ban', isAuthenticated, isUserBanned, (req, res) => {
    res.send('YOU ARE NOT BANNED ')
});




module.exports.bcrypt = bcrypt; // <-- heroku

sequelize.sync({ force: false }).then(() => { // <-- TEST SHIPPING HISTORIES. AND THE DEBUGGING ROUTE /ALLHISTORIES. 
    const PORT = process.env.PORT || 3001;
    app.listen(PORT, () => {
        console.log(`Server running on Port: ${PORT}`);
    });
});


/*
esto falta implementar.
  // eliminar un producto de una categoria
  app.delete('/products/:productId/categories/:categoryId', async (req, res) => {
    try {
      const { productId, categoryId } = req.params;
  
     
      const product = await Product.findByPk(productId);
  
      
      if (product) {
        await product.removeCategory(categoryId);
        res.json({ message: 'Product removed from category successfully' });
      } else {
        res.status(404).json({ error: 'Product not found' });
      }
    } catch (error) {
      console.error('Error removing product from category:', error);
      res.status(500).json({ error: 'Internal server error' });
    }
  });

*/


/*
EXTRA: USUARIOS PUEDEN TENER VARIAS DIRECCIONES, COMO EN AMAZON:

// Endpoint to retrieve all shipping addresses for a user
app.get('/shipping-addresses', async (req, res) => {
    const userId = req.user.id; // Assuming userId is obtained from the authenticated user

    try {
        // Retrieve all shipping addresses associated with the user
        const shippingAddresses = await Shipping.findAll({ where: { userId: userId } });
        
        res.json(shippingAddresses);
    } catch (error) {
        console.error('Error retrieving shipping addresses:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Endpoint to add a new shipping address for a user
app.post('/shipping-addresses', async (req, res) => {
    const userId = req.user.id; // Assuming userId is obtained from the authenticated user
    const { country, city, zipCode } = req.body;

    try {
        // Create a new shipping address record associated with the user
        const newShippingAddress = await Shipping.create({
            userId: userId,
            country: country,
            city: city,
            zipCode: zipCode
        });
        
        res.json(newShippingAddress);
    } catch (error) {
        console.error('Error adding shipping address:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});

// Endpoint to delete a shipping address for a user
app.delete('/shipping-addresses/:shippingAddressId', async (req, res) => {
    const userId = req.user.id; // Assuming userId is obtained from the authenticated user
    const shippingAddressId = req.params.shippingAddressId;

    try {
        // Delete the specified shipping address associated with the user
        await Shipping.destroy({ where: { id: shippingAddressId, userId: userId } });
        
        res.json({ message: 'Shipping address deleted successfully' });
    } catch (error) {
        console.error('Error deleting shipping address:', error);
        res.status(500).json({ error: 'Internal server error' });
    }
});







// STRIPE, RELATION WITH PRODUCT, USER AND ORDER.
app.post('/create-checkout-session', isAuthenticated, isUserBanned, async (req, res) => {
    const userId = req.user.userId;
    const products = req.body.products;
    const { nickname, reqShippingId } = req.body; // Rename shippingId to reqShippingId

    let transaction;
    let shippingId;

    if (!reqShippingId) {
        return res.status(400).json('Debe entregar al menos un dato de envio (ID o nickname) de su direccion de envio')
    };


    let orderId;
    try {
        // arreglar bug en el cual usuarios podian usar shippingId de otros usuarios.
        // tambien se puede agreagr where: {nickname: nickname} mas tarde.
        const userShippingInfo = await Shipping.findOne({ where: { userId: userId, shippingId: reqShippingId } });

        if (!userShippingInfo) {
            return res.status(400).json('Aun no tienes informacion de envio, o tu info de envio esta incorrecta.');
        };


        const shippingInfo = await Shipping.findOne({where: {shippingId: reqShippingId}});
        if (!shippingInfo) {
            return res.status(404).json('No se encontró la información de envío especificada.');
        }


        shippingId = shippingInfo.shippingId;
        console.log(`USER SHIPPING ID: ${shippingId}`);
        

        transaction = await sequelize.transaction(); 
        
        const items = [];
        const outOfStockProducts = [];
        const paymentHistoryData = [];
        let totalAmount = 0; 
        
        for (const product of products) {
            const checkProductExists = await Product.findByPk(product.id);
            if (!checkProductExists) {
                await transaction.rollback();
                return res.status(404).json('Un producto en tu carrito no existe');
            }

            product.shippingId = shippingId;

            const productFromDB = await Product.findByPk(product.id, { transaction });

            if (!productFromDB) {
                await transaction.rollback();
                return res.status(400).json({ error: `Product with ID ${product.id} not found.` });
            }

            if (product.quantity > productFromDB.stock) {
                await transaction.rollback();
                outOfStockProducts.push(productFromDB.name);
                return res.status(400).json({ error: `Product ${productFromDB.product} is out of stock.` });
            }

            productFromDB.stock -= product.quantity;
            await productFromDB.save({ transaction });

            items.push({
                price_data: {
                    currency: 'usd',
                    product_data: {
                        name: productFromDB.product, 
                        images: productFromDB.image ? [productFromDB.image] : [],
                    },
                    unit_amount: productFromDB.price * 100, // Stripe lo pone en centavos asi que se multiplica.
                },
                quantity: product.quantity
            });

            const subtotal = productFromDB.price * product.quantity;
            totalAmount += subtotal;


            // create order
            const newOrder = await Order.create({
                userId: userId,
                totalAmount: totalAmount,
                paymentStatus: 'pending' // Assuming the initial status is pending
            }, { transaction });
        
            orderId = newOrder.id; // Retrieve the generated orderId
            await newOrder.addProducts(productFromDB, { through: { quantity: product.quantity }, transaction }); // <-- FIX THIS LINE

            paymentHistoryData.push({
                userId: userId,
                productId: product.id,
                quantity: product.quantity,
                purchaseDate: new Date(),
                total_transaction_amount: subtotal,
                shippingId: shippingId,
                orderId: orderId  // <-- cannot find it.
            });
        };

        await transaction.commit();

        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: items,
            mode: 'payment',
            success_url: 'http://localhost:3000/paymenthistory', 
            cancel_url: 'https://www.example.com/cancel', 
        });

        await PaymentHistory.bulkCreate(paymentHistoryData);

        res.json({ id: session.id });
    } catch (error) {
        console.error('Error creating checkout session:', error);
        if (transaction) {
            await transaction.rollback();
        }
        res.status(500).json({ error: 'Internal server error' });
    }
});



ruta para crear producto con brandId cambiada a brandName.
app.post('/product', isAuthenticated, isAdmin, async (req, res) => {
    try {
        const { 
            brandName, // Change brandId to brandName
            product, 
            stock, 
            price, 
            description, 
            tags, 
            attributes, 
            salePrice, 
            featured, 
            // IMAGE    <-- 
            categoryNames
        } = req.body;

        const userId = req.user.userId; // Extract userId from the decoded JWT token
        // no se debe agregar review al producto a la hora de crearlo, esa es tarea de los usuarios.
        // check that brandId exists.

        // revisar si el producto ya existe
        const checkProductExists = await Product.findOne({
            where: {product: product}
        });
        if (checkProductExists) {return res.status(400).json(`El producto con nombre: ${product} ya existe`)};

        // Create or find the brand by name
        let brand = await Brand.findOne({ where: { brand: brandName } });
        if (!brand) {
            // If the brand does not exist, create it
            brand = await Brand.create({ brand: brandName });
        }

        // Create the product with the provided attributes, userId, and brandId
        const createdProduct = await Product.create({
            brandId: brand.id, // Use the brand's id
            product,
            stock,
            price, 
            description,
            tags,
            attributes,
            salePrice,
            featured,
            userId // Include userId
        });

        // Revisar si las categorías existen o crearlas
        if (categoryNames && categoryNames.length > 0) {
            const categories = await Promise.all(categoryNames.map(async (categoryData) => {
                // Find or create category by name
                let category = await Category.findOne({ where: { category: categoryData.name } });
                if (!category) {
                    category = await Category.create({ category: categoryData.name, description: categoryData.description });
                }
                return category;
            }));
            await createdProduct.addCategories(categories);
        }

        //SEND EMAIL. Al crear un producto TODOS los usuarios recibiran un correo con el nombre del nuevo producto agreagdo.
        const transporter = await initializeTransporter();
        const users = await User.findAll();
        for (const user of users) {
            if (user.email) {
                const userEmail = user.email;
                await sendMail(transporter, userEmail, 
                `Hemos agregado un nuevo producto`, `Que tal? te escribimos porque hemos agregado un nuevo producto a la 
                tienda, ya disponible para adquirir ! ${createdProduct.product}`);
            }
        }
        
        res.status(201).json({ message: `Product added successfully`, product: createdProduct });
    } catch (error) {
        res.status(500).json({ error: `Internal Server Error: ${error}` });
    }
});


*/