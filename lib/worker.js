var SCWorker = require("socketcluster/scworker");
var express = require("express");
var createStore = require("./store");
var cors = require("cors");
var bodyParser = require("body-parser");
var path = require("path");
var morgan = require("morgan");
var healthChecker = require("sc-framework-health-check");

class Worker extends SCWorker {
  run() {
    console.log("   >> Worker PID:", process.pid);
    var environment = this.options.environment;

    var app = express();

    var httpServer = this.httpServer;
    var scServer = this.scServer;
    var store = createStore(this.options);
    var worker = this;

    if (environment === "dev") {
      // Log every HTTP request. See https://github.com/expressjs/morgan for other
      // available formats.
      app.use(morgan("dev"));
    }

    // Add GET /health-check express route
    healthChecker.attach(this, app);

    httpServer.on("request", app);
    app.set("view engine", "ejs");
    app.set("views", path.resolve(__dirname, "..", "views"));

    app.get("*", function(req, res) {
      res.render("index", { port: worker.options.port });
    });

    app.use(cors({ methods: "POST" }));
    app.use(bodyParser.json());
    app.use(bodyParser.urlencoded({ extended: false }));
    app.post("/", function(req, res) {
      if (!req.body) return res.status(404).end();
      if (req.body.event === "log") {
        scServer.exchange.publish("log", req.body);
        res.status(200).send({ code: "200" });
      }
      switch (req.body.op) {
        case "get":
          store.get(req.body.id).then(function(r) {
            res.send(r || {});
          });
          break;
        case "list":
          store.list(req.body.query, req.body.fields).then(function(r) {
            res.send(r);
          });
          break;
        default:
          store.add(req.body).then(function(r) {
            res.send({ id: r.id, error: r.error });
            scServer.exchange.publish("report", {
              type: "add",
              data: store.selectors.byBaseFields(r)
            });
          });
      }
    });

    var count = 0;

    scServer.addMiddleware(scServer.MIDDLEWARE_EMIT, function(req, next) {
      var channel = req.event;
      var data = req.data;
      if (
        channel.substr(0, 3) === "sc-" ||
        channel === "respond" ||
        channel === "log"
      ) {
        scServer.exchange.publish(channel, data);
      } else if (channel === "log-noid") {
        scServer.exchange.publish("log", { id: req.socket.id, data: data });
      }
      next();
    });

    scServer.addMiddleware(scServer.MIDDLEWARE_SUBSCRIBE, function(req, next) {
      next();
      if (req.channel === "report") {
        store.list().then(function(data) {
          req.socket.emit(req.channel, { type: "list", data: data });
        });
      }
    });

    scServer.on("connection", function(socket) {
      var channelToWatch, channelToEmit;
      socket.on("login", function(credentials, respond) {
        if (credentials === "master") {
          channelToWatch = "respond";
          channelToEmit = "log";
        } else {
          channelToWatch = "log";
          channelToEmit = "respond";
        }
        worker.exchange.subscribe("sc-" + socket.id).watch(function(msg) {
          socket.emit(channelToWatch, msg);
        });
        respond(null, channelToWatch);
      });
      socket.on("getReport", function(id, respond) {
        store.get(id).then(function(data) {
          console.log(data, respond);
          respond(null, data);
        });
      });
      socket.on("disconnect", function() {
        var channel = worker.exchange.channel("sc-" + socket.id);
        channel.unsubscribe();
        channel.destroy();
        scServer.exchange.publish(channelToEmit, {
          id: socket.id,
          type: "DISCONNECTED"
        });
      });
    });
  }
}

new Worker();
