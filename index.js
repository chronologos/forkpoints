var dotenv = require('dotenv');
dotenv.load();
var _ = require('lodash');
var express = require('express');
var bodyParser = require('body-parser');
var session = require('cookie-session');
var app = express();
var request = require('request');
var async = require('async');
var moment = require('moment');
// var sendgrid = require("sendgrid")(process.env.SENDGRID_USERNAME, process.env.SENDGRID_PASSWORD);
var token_broker = "https://oauth.oit.duke.edu/oauth/token.php";
var duke_card_host = "https://dukecard-proxy.oit.duke.edu";
var auth_url = process.env.ROOT_URL + "/home/auth";
var db = require('monk')(process.env.MONGOHQ_URL || "mongodb://localhost/foodpoints");
var users = db.get("users");
var balances = db.get("balances");
var budgets = db.get("budgets");
var passport = require('passport'); // for oauth login
var favicon = require('serve-favicon'); //serve favicon for site
var munge = require('munge'); //obfuscate email
var compression = require('compression'); //compress html to decrease page load time
console.log("We are in " + process.env.NODE_ENV);
console.log(__dirname + '/public/favicon.ico');
app.use(favicon(__dirname + '/public/favicon.ico'));
app.use(compression());

// redis for storing weekly and monthly stats
// ------------------------------------------
var redis = require('redis'),
  client = redis.createClient(process.env.REDIS_URL);
client.on("error", function(err) {
  console.log("Error " + err);
});
client.on('connect', function() {
  console.log('Connected to Redis');
});
client.set('framework', 'AngularJS');

// Check state of saved values in Redis Server
client.lindex("daily", 0, function(err, res) {
  console.log("Item at index 0 of daily list: " + res);
});

client.lindex("daily", -1, function(err, res) {
  console.log("Item at last index of daily list: " + res);
});

client.get("savedDaily", function(err, res) {
  if (err) {
    console.log("Error in retrieving savedDaily: " + err);
  } else {
    console.log("Value of savedDaily: " + res);
    console.log("Type of savedDaily: " + typeof(res));
  }
});
client.lrange("weekly", 0, -1, function(err, res) {
  console.log("Weekly average data so far: \n");
  console.log(res);
});

var globalAverage = 0;
users.index('id', {
  unique: true
});
app.set('view engine', 'jade');
app.use(bodyParser.json());
app.use(express.static(__dirname + '/public'));
if (process.env.NODE_ENV == "development") {
  app.use(session({
    name: 'devsession',
    keys: ['key1', 'key2']
  }));
} else {
  app.use(session({
    secret: process.env.SESSION_SECRET
  }));
}
app.use(passport.initialize());
app.use(passport.session());
app.locals.moment = moment;
passport.serializeUser(function(user, done) {
  done(null, user);
});
passport.deserializeUser(function(obj, done) {
  done(null, obj);
});
var GoogleStrategy = require('passport-google-oauth').OAuth2Strategy;
passport.use(new GoogleStrategy({
  clientID: process.env.GOOGLE_CLIENT_ID,
  clientSecret: process.env.GOOGLE_CLIENT_SECRET,
  callbackURL: process.env.ROOT_URL + "/auth/google/return"
}, function(token, tokenSecret, profile, done) {
  profile = profile._json;
  console.log(profile);
  done(null, profile);
}));

// Redirect the user to Google for authentication. req.user is set to authenticated user
app.get('/login', function(req, res) {
  res.render('login.jade', {
    emailContact: munge('yi.yan.tay+foodpoints@duke.edu')

  });
});

// Redirect the user to Google for authentication. req.user is set to authenticated user
app.get('/auth/google', passport.authenticate('google', {
  scope: 'openid email'
}));

// Google will redirect the user to this URL after authentication.  Finish
// the process by verifying the assertion.  If valid, the user will be
// logged in.  Otherwise, authentication has failed.
app.get('/auth/google/return', passport.authenticate('google', {
  successRedirect: '/',
  failureRedirect: '/login'
}));

// a middleware with no mount path; gets executed for every request to the app
app.use(function(req, res, next) {
  if (req.user) {
    //user is logged in
    users.findAndModify({
      id: req.user.id
    }, {
      $set: req.user
    }, {
      upsert: true,
      new: true
    }, function(err, user) {
      balances.find({
        user_id: user._id
      }, {
        sort: {
          date: -1
        }
      }, function(err, bals) {
        user.balances = bals;
        // new user or error getting balance
        if (user.balances.length === 0) {
          user.new = true;
        }
        getTransactions(user, function(err, trans) {
          user.trans = trans;
          req.user = user;
          next();
        });
      });
    });
  } else {
    console.log("no user detected")
    res.redirect('/login');
  }
});

if (process.env.NODE_ENV == 'production') {
  var host = process.env.HOST;
} else {
  var host = 'localhost';
}
var port = (process.env.PORT || 3000);
app.listen(port, function() {
  console.log("Node app is running, server started on " + host + ":" + port);
});

app.use("/api", function(req, res, next) {
  if (req.user) {
    next();
  } else {
    res.status(403).json({
      error: "Not logged in"
    });
  }
});

app.use(function(req, res, next) {
  if (req.headers['x-forwarded-proto'] !== 'https' && process.env.NODE_ENV === "production") {
    res.redirect(['https://', req.get('host'), req.url].join(''));
  } else {
    next();
  }
});



app.get('/', function(req, res) {
  res.render('index.jade', {
    auth_link: "https://oauth.oit.duke.edu/oauth/authorize.php?response_type=code&client_id=" + process.env.API_ID + "&state=xyz&scope=food_points&redirect_uri=" + auth_url,
    user: req.user,
    emailContact: munge('yi.yan.tay+foodpoints@duke.edu')
  });
});
app.get('/home/auth', function(req, res) {
  var code = req.query.code;
  request.post(token_broker, {
    auth: {
      'user': process.env.API_ID,
      'pass': process.env.API_SECRET
    },
    form: {
      grant_type: "authorization_code",
      code: code,
      redirect_uri: auth_url
    }
  }, function(err, resp, body) {
    body = parseLodash(body);
    users.update({
      _id: req.user._id
    }, {
      $set: {
        refresh_token: body.refresh_token,
        refresh_token_expire: new Date(moment().add(6, 'months'))
      }
    }, function(err) {
      res.redirect('/');
    });
  });
});

app.get('/logout', function(req, res) {
  req.session = null;
  req.logout();
  res.redirect('/');
});
//get user
app.get('/api/user', function(req, res) {
  res.json(req.user);
});
//unsubscribe
app.get('/api/delete', function(req, res) {
  if (req.user) {
    users.remove({
      id: req.user.id
    });
    req.logout();
    req.session = null;
    res.redirect('/');
  } else {
    next();
  }
});
//average spending
app.get('/api/spending', function(req, res) {
  res.set("text/plain");
  if (globalAverage === 0) {
    client.lindex("daily", 0, function(err, response) {
      globalAverage = response;
      console.log("As server restarted, daily average value of " + response + " was retrieved from Redis");
      res.send("" + globalAverage);
    });
  } else {
    res.send("" + globalAverage);
  }
});

//User's total spending today

app.get('/api/personal', function(req, res) {
  //res.set("text/plain");
  res.set("application/json");
  console.log("GET request to user's personal data detected.");
  //getTransactions(req.user, getPersonalStats(arr, function(info) {
  getTransactions(req.user, function(err, arr) {
    //var dayStart = new Date(new Date() - 24 * 60 * 60 * 1000) Exactly 24 hours ago from this moment
    var dayStart = getCutoffs().day;
    //var weekStart = getCutoffs()['week']; THIS COUNTS FROM THE LATEST SUNDAY, WHICH IS INCONSISTENT WITH STORING LAST 7 DAYS IN REDIS
    var weekStart = new Date(new Date() - 7 * 24 * 60 * 60 * 1000); // Exactly 7 days ago from this moment
    var dailyTotal = 0;
    var weeklyTotal = 0;
    var info = {};
    arr.forEach(function(trans) {
      if (trans.date > dayStart) {
        //dailyTotal += trans.date > dayStart ? Math.abs(trans.amount) : 0;
        var val = Math.abs(trans.amount);
        dailyTotal += val;
        weeklyTotal += val;
      } else if (trans.date > weekStart) {
        weeklyTotal += Math.abs(trans.amount);
      } else {
        return;
      }
    });
    console.log("Amount spent by user today : " + dailyTotal);
    console.log("Amount spent by user this week : " + dailyTotal);
    info.day = dailyTotal;
    info.week = weeklyTotal;
    res.send(info);
  });
});

// Aggregate weekly spending data
app.get('/api/spending/weekly', function(req, res) {
  res.set("text/plain");
  console.log("GET request for weekly aggregate data detected");
  getWeeklySum(function(total) {
    //    if (err) {
    //        console.log(err);
    //    }
    console.log("Sending value of " + total + " for weekly sum");
    res.send("" + total);
  });
});

//create
app.post('/api/budgets', function(req, res) {
  req.body.user_id = req.user._id;
  req.body.triggered = -1;
  req.body.date = new Date();
  budgets.insert(req.body, function(err, doc) {
    res.send(doc);
  });
});
//query
app.get('/api/budgets', function(req, res) {
  getBudgetStatus(req.user, function(err, docs) {
    res.send(docs);
  });
});
//delete
app.delete('/api/budgets/:id', function(req, res) {
  budgets.remove({
    _id: req.params.id,
    user_id: req.user._id
  }, function(err) {
    res.json({
      deleted: 1
    });
  });
});
app.get('/api/cutoffs', function(req, res) {
  res.send(getCutoffs());
});

updateBalances();

function getCurrentBalance(user, cb) {
  var access_token = user.access_token;
  request.post(duke_card_host + "/food_points", {
    form: {
      access_token: access_token
    }
  }, function(err, resp, body) {
    if (err || resp.statusCode != 200 || !body) {
      console.log(err, body);
      return cb("error getting balance");
    }
    body = parseLodash(body);
    cb(err, Number(body.food_points));
  });
}

function validateTokens(user, cb) {
  //refresh token expired, unset it
  if (new Date() > user.refresh_token_expire) {
    console.log("refresh token expired");
    users.update({
      _id: user._id
    }, {
      $unset: {
        refresh_token: 1,
        refresh_token_expire: 1
      }
    }, function(err) {
      //can't update this user
      return cb("refresh token expired");
    });
  }
  //access token expired, get a new one
  if (new Date() > user.access_token_expire || !user.access_token) {
    console.log("access token expired");
    getAccessToken(user, function(err, access_token) {
      users.update({
        _id: user._id
      }, {
        $set: {
          access_token: access_token,
          access_token_expire: new Date(moment().add(1, 'hour'))
        }
      }, function(err) {
        console.log("got new access token %s", access_token);
        user.access_token = access_token;
        return cb(err);
      });
    });
  } else {
    //valid token
    console.log("tokens exist");
    return cb(null);
  }
}

function updateBalances() {
  //function to continuously update balances
  //for each user get their most recent balance
  //get a new balance for that user
  //only insert in db if number has changed


  client.lrange("weekly", 0, -1, function(err, res) {
    console.log("Weekly average data so far: \n");
    console.log(res);
  });

  //variables for counting of average $ spent per day
  var spendingAvg = 0;
  var today = new Date();
  var minutes = today.getMinutes();
  var hour = today.getHours();
  var day = today.getDate();
  var month = today.getMonth();
  var year = today.getYear();
  var len = 0;

  users.find({
    refresh_token: {
      $exists: true
    }
  }, function(err, res) {
    if (err) {
      console.log(err);
      return updateBalances();
    }
    len = res.length;
    async.mapSeries(res, function(user, cb) {
      //console.log(user)
      validateTokens(user, function(err, access_token) {
        if (err) {
          //log the error and move on to next user
          console.log(err);
          return cb(null);
        }
        getCurrentBalance(user, function(err, bal) {
          if (err) {
            console.log(err);
            return cb(null);
          }
          console.log("api balance: %s", bal);
          //get db balance
          balances.find({
            user_id: user._id
          }, {
            sort: {
              date: -1
            }
          }, function(err, bals) {
            console.log("bals length" + bals.length);
            var currentIndex = 0;
            var highest = -1;
            var next = -1;

            // average spending code
            if (bals && bals.length > 0) {
              while (currentIndex < bals.length && bals[currentIndex].date.getDate() == day && bals[currentIndex].date.getMonth() == month && bals[currentIndex].date.getYear() == year) {
                if (currentIndex === 0) {
                  highest = bals[currentIndex].balance;
                }
                currentIndex++;
              }
              if (currentIndex >= bals.length) {
                currentIndex = bals.length - 1;
              }
              next = bals[currentIndex].balance;

              console.log("highest : " + highest);
              console.log("next : " + next);
              if (highest != -1) {
                console.log("Adding " + (next - highest) + " to total spending of the day");
                if ((next - highest) >= 0) {
                  spendingAvg += next - highest;
                } else {
                  console.log("Somebody added food points today... Skipping this person!");
                  len--;
                }
              }
            }

            var dbbal = bals[0];

            console.log(dbbal);
            //change in balance, or no balances
            if (!dbbal || Math.abs(dbbal.balance - bal) >= 0.01) {
              var newBal = {
                user_id: user._id,
                balance: bal,
                date: new Date()
              };
              balances.insert(newBal, function(err) {
                getBudgetStatus(user, function(err, docs) {
                  docs.forEach(function(budget) {
                    if (budget.spent >= budget.amount && budget.triggered < budget.cutoff) {
                      var text = "<p>Hello " + user.given_name + ",</p>";
                      text += '<p>You spent ' + budget.spent.toFixed(2) + ' this ' + budget.period + ', exceeding your budget of ' + budget.amount.toFixed(2) + '.</p>';
                      text += '<p>To stop receiving these emails, remove your budgeting alert at ' + process.env.ROOT_URL + '</p>';
                      sendEmail(text, user.email, function(err) {
                        budget.triggered = new Date();
                        budgets.update({
                          _id: budget._id
                        }, budget);
                      });
                    }
                  });
                });

              });
            }
            //wait before next user
            setTimeout(cb, 10000);
          });
        });
      });
    }, function(err) {
      if (err) {
        console.log("error in updating transactions");
        console.log(err);
      }
      //done with a pass through all users, restart
      // this number is average amount spent today
      globalAverage = spendingAvg / len;
      console.log("Average spent today is " + globalAverage);
      client.lpush(["daily", globalAverage], function(err, res) {
        if (err) {
          console.log(err);
        } else {
          console.log("Pushed" + globalAverage + "onto today's averages");
          console.log("Number of average values stored for today: " + res);
          client.ltrim("daily", 0, 0);
          if (hour === 23 && minutes > 40) {
            client.get("savedDaily", function(err, rep) {
              if (rep === "0") {
                client.lpush(["weekly", globalAverage], function(err, resp) {
                  if (err) {
                    console.log("Error in saving today's spending into weekly data: " + err);
                  } else {
                    client.ltrim("weekly", 0, 6);
                    console.log("Saved today's spending into weekly data");
                    client.lrange("weekly", 0, -1, function(err, response) {
                      console.log("Weekly data so far:\n");
                      console.log(response);
                      client.set("savedDaily", 1, function(error, reply) {
                        if (err) {
                          console.log("Unable to set savedDaily to 1: " + error);
                        } else {
                          console.log("Set value of savedDaily to 1 to prevent repetition");
                        }
                      });
                    });
                  }
                });
              } else {
                console.log("Already saved daily average into weekly array");
              }
            });

          }
          if (hour === 22) {
            client.set("savedDaily", 0, function(err, rep) {
              if (err) {
                console.log("Unable to reset value of savedDaily: " + err);
              } else {
                console.log("Reset value of savedDaily to enable saving of today's average into weekly data");
              }


            });
          }
        }
      });
      updateBalances();
    });
  });
}

function getCutoffs() {
  return {
    'day': new Date(moment().startOf('day')),
    'week': new Date(moment().startOf('week')),
    'month': new Date(moment().startOf('month'))
  };
}

function getBudgetStatus(user, cb) {
  var cutoffs = getCutoffs();
  getTransactions(user, function(err, trans) {
    budgets.find({
      user_id: user._id
    }, {
      sort: {
        date: 1
      }
    }, function(err, docs) {
      docs.forEach(function(budget) {
        var cutoff = cutoffs[budget.period];
        var exp = 0;
        trans.forEach(function(tran) {
          exp += tran.date > cutoff && tran.amount < 0 ? Math.abs(tran.amount) : 0;
        });
        budget.spent = exp;
        budget.cutoff = cutoff;
      });
      cb(err, docs);
    });
  });
}

function sendEmail(text, recipient, cb) {
  var payload = {
    html: text,
    from: "no-reply",
    to: recipient,
    subject: 'FoodPoints+ Alert'
  };
  console.log(payload);
  sendgrid.send(payload, function(err, json) {
    console.log(json);
    cb(err);
  });
}

function getAccessToken(user, cb) {
  var refresh_token = user.refresh_token;
  request.post(token_broker, {
    auth: {
      'user': process.env.API_ID,
      'pass': process.env.API_SECRET
    },
    form: {
      grant_type: "refresh_token",
      refresh_token: refresh_token
    }
  }, function(err, resp, body) {
    if (err || resp.statusCode != 200 || !body) {
      return cb("error getting access token");
    }
    body = parseLodash(body);
    cb(err, body.access_token);
  });
}

function getTransactions(user, cb) {
  balances.find({
    user_id: user._id
  }, {
    sort: {
      date: -1
    }
  }, function(err, bals) {
    //compute transactions
    var arr = [];
    for (var i = 0; i < bals.length; i++) {
      if (bals[i + 1]) {
        //newer number subtract older number
        var diff = bals[i].balance - bals[i + 1].balance;
        arr.push({
          amount: diff,
          date: bals[i].date
        });
      }
    }
    cb(err, arr);
  });
}

// http://colintoh.com/blog/lodash-10-javascript-utility-functions-stop-rewriting
function parseLodash(str) {
  return _.attempt(JSON.parse.bind(null, str));
}

function getWeeklySum(cb) {
  var total = 0;
  client.lrange("weekly", 0, -1, function(err, rep) {
    if (err) {
      console.log("Unable to retrieve weekly info: " + err);
      return 0;
    } else {
      rep.forEach(function(val) {
        total += parseFloat(val);
      });
    }
    cb(total);
  });
}
