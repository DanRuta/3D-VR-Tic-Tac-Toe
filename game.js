"use strict"

let sendData, returnError, websocketClients=[], keys

const fs = require("fs")
const pug = require("pug")
const fetch = require("node-fetch")
const db = require("./game-MongoDB")

try {
    keys = JSON.parse(fs.readFileSync("./keys.json"))
} catch (e) {
    console.log("Could not parse keys. Did you remember to add the keys.json file?\n\n", e)
}
const googleClientId = process.argv.includes("dev") ? keys.dev : keys.dist

let rooms = []
let usersData = []

// GET
// ===
const index = (request, response) => {
    sendData({request, response, code: 200, data: fs.readFileSync("game.html", "utf8"), contentType: "text/html"})
}


// old. to be removed/changed
const userArea = (request, response) => {

    let user
    const username = request.url.split("/users/")[1].toLowerCase()

    for (let userIndex in usersData) {

        const currentUser = usersData[userIndex]

        if (currentUser.username.toLowerCase().replace(/\s/g,"-")==username) {
            user = userIndex
            break
        }
    }


    if (!user) return returnError(response, "404")

    let imagePaths=[]

    try {
        imagePaths = fs.readdirSync(`./screenshots/${user}`)
                       .map(fileName => {return {path: `screenshots/${user}/${fileName}`}})
    } catch(e) {}

    sendData({request, response, code: 200, data: pug.renderFile("./userArea.pug", {
        username: usersData[user].username,
        userId: user,
        scribbles: imagePaths,
        plural: (!imagePaths.length || imagePaths.length>1) ? "s" : "",
        googleClientId
    }), contentType: "text/html"})
}



// POST
// ====
const getAIMove = async (request, response, {gameState}) => {

    const moves = getAvailableMoves(gameState)
    const queries = []
    const key = gameState.join("").replace(/,/g,"")

    // TODO, batch these queries
    for (let m=0; m<moves.length; m++) {
        queries.push(db.getQ(key + moves[m].toString().replace(/,/g, "")))
    }

    Promise.all(queries).then((qs, qi) => {
        qs = qs.map(record => {

            if (record.length) {
                return record[0].value
            } else {
                db.setQ(key + moves[qi].toString().replace(/,/g, ""), 1)
                return 1
            }
        })
        const maxQ = qs.slice(0).sort().reverse()[0]

        sendData({request, response, code: 200, data: JSON.stringify({move: moves[qs.indexOf(maxQ)]})})
    })
}

const rewardAI = (request, response, {value, gameState}) => {
    // TODO, lastState+lastMove
    sendData({request, response, code: 200, data: "{}"})
}



const roomExists = (request, response, {roomName}) => {
    sendData({request, response, code: 200, data: JSON.stringify({roomExists: rooms.includes(roomName), roomName}), contentType: "text/plain"})
}

const createRoom = async(request, response, {roomName}) => {

    let responseData

//    if (!rooms.includes(roomName)) {
//        rooms.push(roomName)
//        responseData = roomName
//    }
    let roomExists = await db.getRoom(roomName);

    if(roomExists === []) {
      let room = await db.createRoom(roomName)
      responseData = roomName;
    }

    sendData({request, response, code: 200, data: JSON.stringify({roomName: responseData}), contentType: "text/plain"})
}

const createEditRoom = async(request, response, {roomName}) => {

    let responseData, counter

    // Check if the room name is available. If not, incrementally assign a suffix number to it
    do {
        responseData = roomName+(counter ? counter : "")
        counter = counter ? counter+1 : 1

    } while (rooms.includes(responseData))

    sendData({request, response, code: 200, data: JSON.stringify({roomName: responseData}), contentType: "text/plain"})
}

const tokenSignin = async (request, response, {authenticator, token, roomName}) => {

    let roomExists

    authenticateUser(token, authenticator, ({id, name, email}) => {

        let username
        let newUser = false
        let userFound = false
        let userId

        // Check if the user exists, by looping through usersData object
        for (let userIndex in usersData) {

            const currentUser = usersData[userIndex]

            // Update existing user data
            // if (currentUser.authUserID[authenticator]==id) {
            if (currentUser.authUserID==id) {

                userFound = true
                userId = userIndex
                username = currentUser.username

                if (currentUser.email != email) {
                    currentUser.email = email
                }

                usersData[userId].timesLoggedIn++

                break
            }
        }

        if (!userFound) {
            console.log("Creating new user")

            // Create new user with incremental ID, and name defaulted to name from authenticator
            userId = Object.keys(usersData).length

            // Check if the username is taken
            let usernameCount = 0

            for(let userId in usersData) {
                if (usersData[userId].username==name) {
                    usernameCount++
                }
            }

            const newUserData = {
                username : usernameCount>0 ? name+usernameCount : name,
                authUserID: id,
                email: undefined,
                timesLoggedIn: 1,
                screenshotsTaken: 0
            }


            newUserData.email = email

            username = newUserData.username
            newUser = true

            // Add new user to the user data
            usersData[userId] = newUserData
        }
        fs.writeFile("./usersData.json", JSON.stringify(usersData, null, 4),()=>{})

        const finishAndSend = () => sendData({request, response, code: 200, data: JSON.stringify({username, userId, newUser, roomExists})})

        // console.log(rooms)
        if (roomName) {

            roomExists = rooms.includes(roomName)
            finishAndSend()

        } else {
            finishAndSend()
        }
    })
}

const changeUsername = (request, response, {newName, token, authenticator}) => {
    authenticateUser(token, authenticator, ({id}) => {

        let existingNameFound = false
        let userToChange

        for (let userIndex in usersData) {

            const currentUser = usersData[userIndex]

            if (currentUser.authUserID==id) {
                userToChange = userIndex
            } else if (currentUser.username==newName) {
                existingNameFound=true
            }
        }

        if (existingNameFound) {
            return sendData({request, response, code: 200, data: JSON.stringify({})})
        }

        usersData[userToChange].username = newName

        fs.writeFile("./usersData.json", JSON.stringify(usersData, null, 4), ()=>{})
        sendData({request, response, code: 200, data: JSON.stringify({newName})})
    })
}



const handleWebSocket = (connection, clients) => {

    websocketClients = clients

    try {
        connection.on("message", message => {

            message = JSON.parse(message)

            // Register the user data to the connection
            if (!connection.meta) {
                connection.meta = {
                    userId: message.userId,
                    username : message.username,
                    room: message.room,
                    type: message.type
                }
            }

            websocketClients.forEach(client => {
                if (client.meta && client.meta.room == connection.meta.room) {
                    client.send(JSON.stringify(message))
                }
            })
        })

        connection.on("close", () => {

            // Remove the connection from the websocketClients list
            websocketClients.splice(websocketClients.indexOf(connection), 1)

            if (!connection.meta) {
                return
            }

            let roomIsEmpty = true

            websocketClients.forEach(client => {

                if (!client.meta)   return

                if (client.meta.room==connection.meta.room) {

                    roomIsEmpty = false

                    try {
                        client.send(JSON.stringify({username: connection.meta.username, disconnectedType: connection.meta.type}))
                    } catch(e) {
                        console.warn("Error broadcasting closed connection", connection.meta, e)
                    }
                }
            })

            if (roomIsEmpty) {
                setTimeout(() => {

                    let roomStillEmpty = true

                    websocketClients.forEach(client => {
                        if (client.meta.room==connection.meta.room) {
                            roomStillEmpty = false
                        }
                    })

                    if (roomStillEmpty) {
                        rooms.splice(rooms.indexOf(connection.meta.room), 1)
                    }

                }, 10000)
            }
        })
    } catch(e) {console.log(`\nPrevented WebSocket crash. Rooms: ${rooms} Meta: ${connection.meta}`)}
}



// Helper Functions
// ================
const authenticateUser = (token, authenticator, callback) => {
    fetch(`https://www.googleapis.com/oauth2/v3/tokeninfo?id_token=${token}`)
    .then(googleResponse => googleResponse.json())
    .then(({aud,name,sub,email,picture}) => {

        if (aud.includes(googleClientId)) {
            callback({id: sub, name, email, picture})
        }
    })
}

const getAvailableMoves = gameState => {
    const moves = []
    const span = gameState[0].length

    console.log("checking", gameState, span)

    // for (let b=0; b<span; b++) {
        for (let r=0; r<span; r++) {
            for (let c=0; c<span; c++) {
                // if (Number.isNaN(parseInt(gameState[b][r][c]))) {
                if (Number.isNaN(parseInt(gameState[0][r][c]))) {
                    // moves.push([b, r, c])
                    moves.push([0, r, c])
                }
            }
        }
    // }

    return moves
}

// Export routes to these functions to the server
exports.initProject = ({sendDataCallback, error}) => {
    sendData = sendDataCallback
    returnError = error

    usersData = JSON.parse(fs.readFileSync("./usersData.json"))
    rooms = []

    return {
        get: {
            [/$/] : index,
            [/users\/[^\/]+$/] : userArea
        },
        post: {
            [/getAIMove/] : getAIMove,
            [/rewardAI/] : rewardAI,

            [/roomExists/] : roomExists,
            [/createRoom/] : createRoom,
            [/createEditRoom/] : createEditRoom,
            [/tokenSignin/] : tokenSignin,
            [/changeUsername/] : changeUsername
        },
        ws: handleWebSocket
    }
}