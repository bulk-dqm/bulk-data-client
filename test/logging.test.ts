import { existsSync, rmSync }              from "fs"
import { expect }                          from "@hapi/code"
import { emptyFolder, mockServer, invoke } from "./lib"



describe('Logging', function () {

    this.timeout(10000);

    after(async () => {
        emptyFolder(__dirname + "/tmp/downloads/attachments")
        emptyFolder(__dirname + "/tmp/downloads/error")
        emptyFolder(__dirname + "/tmp/downloads/deleted")
        emptyFolder(__dirname + "/tmp/downloads")
    });
    
    afterEach(async () => {
        if (existsSync(__dirname + "/tmp/log.ndjson")) {
            rmSync(__dirname + "/tmp/log.ndjson")
        }
        if (existsSync(__dirname + "/tmp/config.js")) {
            rmSync(__dirname + "/tmp/config.js")
        }
    })
    
    describe('kickoff', () => {

        // Emits the kickOffEnd event if we got error response
        it ("emits kickoff in case of server error", async () => {

            mockServer.mock("/metadata", {
                status: 200,
                body: {
                    fhirVersion: 100,
                    software: {
                        name: "Software Name",
                        version: "Software Version",
                        releaseDate: "01-02-03"
                    }
                }
            });

            mockServer.mock("/Patient/$export", { status: 404, body: "", headers: { "content-location": "x"}});

            const { log } = await invoke()
            const logs = log.split("\n").filter(Boolean).map(line => JSON.parse(line));
            const entry = logs.find(l => l.eventId === "kickoff")
            
            expect(entry, "kickoff log entry not found").to.exist()
            expect(entry.eventDetail).to.equal({
                "exportUrl": mockServer.baseUrl + "/Patient/$export",
                "errorCode": 404,
                "errorBody": "Not Found",
                "softwareName": "Software Name",
                "softwareVersion": "Software Version",
                "softwareReleaseDate": "01-02-03",
                "fhirVersion": 100,
                "requestParameters": {}
            })
        })

        it ("emits kickoff in case of invalid response", async () => {

            mockServer.mock("/metadata", {
                status: 200,
                body: {
                    fhirVersion: 100,
                    software: {
                        name: "Software Name",
                        version: "Software Version",
                        releaseDate: "01-02-03"
                    }
                }
            });

            mockServer.mock("/Patient/$export", { status: 200, body: "" });

            const { log } = await invoke()
            const logs = log.split("\n").filter(Boolean).map(line => JSON.parse(line));
            const entry = logs.find(l => l.eventId === "kickoff")
            
            expect(entry, "kickoff log entry not found").to.exist()
            expect(entry.eventDetail).to.equal({
                "exportUrl": mockServer.baseUrl + "/Patient/$export",
                "errorCode": 404,
                "errorBody": "Not Found",
                "softwareName": "Software Name",
                "softwareVersion": "Software Version",
                "softwareReleaseDate": "01-02-03",
                "fhirVersion": 100,
                "requestParameters": {}
            })
        })

        it ("emits kickoff in case of missing CapabilityStatement", async () => {

            mockServer.mock("/metadata", { status: 404 });

            mockServer.mock("/Patient/$export", { status: 200, body: "" });

            const { log } = await invoke()
            const logs = log.split("\n").filter(Boolean).map(line => JSON.parse(line));
            const entry = logs.find(l => l.eventId === "kickoff")
            
            expect(entry, "kickoff log entry not found").to.exist()
            expect(entry.eventDetail).to.equal({
                "exportUrl": mockServer.baseUrl + "/Patient/$export",
                "errorCode": 404,
                "errorBody": "Not Found",
                "softwareName": null,
                "softwareVersion": null,
                "softwareReleaseDate": null,
                "fhirVersion": null,
                "requestParameters": {}
            })
        })

        it ("includes request parameters in kickoff log entries", async () => {

            mockServer.mock("/metadata", {
                status: 200,
                body: {
                    fhirVersion: 100,
                    software: {
                        name: "Software Name",
                        version: "Software Version",
                        releaseDate: "01-02-03"
                    }
                }
            });

            mockServer.mock("/Patient/$export", { status: 200 });

            const { log } = await invoke({ args: ["--_since", "2020" ]})
            const logs = log.split("\n").filter(Boolean).map(line => JSON.parse(line));
            const entry = logs.find(l => l.eventId === "kickoff")
            
            expect(entry, "kickoff log entry not found").to.exist()
            expect(entry.eventDetail).to.be.an.object()
            expect(entry.eventDetail.exportUrl).to.be.a.string()
            expect(entry.eventDetail.exportUrl).to.startWith(mockServer.baseUrl + "/Patient/$export")
            expect(entry.eventDetail.exportUrl).to.match(/\?_since=.*$/)
            expect(entry.eventDetail.requestParameters).to.be.an.object()
            expect(entry.eventDetail.requestParameters._since).to.exist()
        })
    })

    describe('status events', () => {

        it ("logs status_progress events in case of 202 status responses", async () => {

            mockServer.mock("/metadata", { status: 200, body: {} });

            mockServer.mock("/Patient/\\$export", {
                status: 200,
                headers: {
                    "content-location": mockServer.baseUrl + "/status"
                },
                body: ""
            });

            let counter = 0

            mockServer.mock("/status", {
                handler(req, res) {
                    if (++counter < 4) {
                        res.setHeader("x-progress", counter * 30 + "%")
                        res.setHeader("retry-after", "1")
                        res.status(202)
                        res.send("")
                    } else {
                        res.json({}) // manifest
                    }
                }
            })

            const { log } = await invoke()
            const logs = log.split("\n").filter(Boolean).map(line => JSON.parse(line)).filter(l => l.eventId === "status_progress");
            
            expect(logs.length, "must have 3 status_progress log entries").to.equal(3)
            expect(logs[0].eventDetail.xProgress).to.equal("30%")
            expect(logs[1].eventDetail.xProgress).to.equal("60%")
            expect(logs[2].eventDetail.xProgress).to.equal("90%")
        })

        it ("logs status_error events", async () => {
            this.timeout(10000);

            mockServer.mock("/metadata", { status: 200, body: {} });

            mockServer.mock("/Patient/\\$export", {
                status: 200,
                headers: {
                    "content-location": mockServer.baseUrl + "/status"
                },
                body: ""
            });

            mockServer.mock("/status", { status: 404, body: "Status endpoint not found" })

            const { log } = await invoke()
            const logs = log.split("\n").filter(Boolean).map(line => JSON.parse(line));
            const entry = logs.find(l => l.eventId === "status_error")
            expect(entry).to.exist()
            expect(entry.eventDetail.code).to.equal(404)
            expect(entry.eventDetail.body).to.equal("Status endpoint not found")
        })

        it ("logs status_complete events", async () => {
            
            mockServer.mock("/metadata", { status: 200, body: {} });

            mockServer.mock("/Patient/\\$export", {
                status: 200,
                headers: {
                    "content-location": mockServer.baseUrl + "/status"
                },
                body: ""
            });

            mockServer.mock("/status", { status: 200, body: {
                transactionTime: new Date().toISOString(),
                output: [{}, {}, {}],
                deleted: [{}, {}],
                error: [{}]
            }})

            const { log } = await invoke()
            const logs = log.split("\n").filter(Boolean).map(line => JSON.parse(line));
            const entry = logs.find(l => l.eventId === "status_complete")
            expect(entry).to.exist()
            expect(entry.eventDetail.transactionTime).to.exist()
            expect(entry.eventDetail.outputFileCount).to.equal(3)
            expect(entry.eventDetail.deletedFileCount).to.equal(2)
            expect(entry.eventDetail.errorFileCount).to.equal(1)
        })

        it ("logs status_error on invalid manifest", async () => {
            this.timeout(10000);

            mockServer.mock("/metadata", { status: 200, body: {} });

            mockServer.mock("/Patient/\\$export", {
                status: 200,
                headers: {
                    "content-location": mockServer.baseUrl + "/status"
                },
                body: ""
            });

            mockServer.mock("/status", { status: 200, body: {}})

            const { log } = await invoke()
            const logs = log.split("\n").filter(Boolean).map(line => JSON.parse(line));
            const entry = logs.find(l => l.eventId === "status_error")
            expect(entry).to.exist()
            expect(entry.eventDetail.code).to.equal(200)
            expect(entry.eventDetail.body).to.equal({})
            expect(entry.eventDetail.message).to.equal(
                "The export manifest output is not an array: Expected undefined " +
                "to be an array but got 'undefined'"
            )
        })

    })

    describe('download events', () => {

        it ("download without errors", async () => {
            
            mockServer.mock("/metadata", { status: 200, body: {} });

            mockServer.mock("/Patient/\\$export", {
                status: 200,
                headers: {
                    "content-location": mockServer.baseUrl + "/status"
                }
            });

            mockServer.mock("/status", { status: 200, body: {
                transactionTime: new Date().toISOString(),
                output: [
                    {
                        url : mockServer.baseUrl + "/downloads/file1",
                        type: "Patient"
                    },
                    {
                        url : mockServer.baseUrl + "/downloads/docRef",
                        type: "DocumentReference"
                    }
                ],
                deleted: [{
                    url : mockServer.baseUrl + "/downloads/deleted",
                    type: "Bundle"
                }],
                error: [{
                    url : mockServer.baseUrl + "/downloads/errors",
                    type: "OperationOutcome"
                }]
            }})

            mockServer.mock("/downloads/file1", { 
                handler(req, res) {
                    res.set("content-type", "application/fhir+ndjson")
                    res.set("Content-Disposition", "attachment")
                    res.end('{"resourceType":"Patient"}\n{"resourceType":"Patient"}')
                }
            })

            mockServer.mock("/downloads/errors", { 
                handler(req, res) {
                    res.set("content-type", "application/fhir+ndjson")
                    res.set("Content-Disposition", "attachment")
                    res.end('{"resourceType":"OperationOutcome"}')
                }
            })

            mockServer.mock("/downloads/deleted", { 
                handler(req, res) {
                    res.set("content-type", "application/fhir+ndjson")
                    res.set("Content-Disposition", "attachment")
                    res.end('{"resourceType":"Bundle"}')
                }
            })

            mockServer.mock("/downloads/docRef", {
                handler(req, res) {
                    res.set("content-type", "application/fhir+ndjson")
                    res.set("Content-Disposition", "attachment")
                    res.json({
                        "resourceType": "DocumentReference",
                        "content": [
                            {
                                "attachment": {
                                    "contentType": "application/pdf",
                                    "url": mockServer.baseUrl + "/document.pdf",
                                    "size": 1084656
                                }
                            }
                        ]
                    })
                }
            })

            mockServer.mock("/document.pdf", { body: "PDF" })

            const { log } = await invoke()
            const logs = log.split("\n").filter(Boolean).map(line => JSON.parse(line))
            
            expect(logs[0]).to.exist()
            expect(logs[0].eventId).to.equal("kickoff")

            expect(logs[1]).to.exist()
            expect(logs[1].eventId).to.equal("status_complete")

            // /downloads/file1 ------------------------------------------------
            {
                const entries = logs.filter(e => e.eventId === "download_request" && e.eventDetail.fileUrl === mockServer.baseUrl + "/downloads/file1")
                expect(
                    entries.length,
                    'download_request should be logged once for "/downloads/file1"'
                ).to.equal(1)
                expect(entries[0].eventDetail.fileUrl, "invalid fileUrl").to.equal(mockServer.baseUrl + "/downloads/file1")
                expect(entries[0].eventDetail.itemType).to.equal("output")
                expect(entries[0].eventDetail.resourceType).to.equal("Patient")
            }

            {
                const entries = logs.filter(e => e.eventId === "download_complete" && e.eventDetail.fileUrl === mockServer.baseUrl + "/downloads/file1")
                expect(
                    entries.length,
                    'download_complete should be logged once for "/downloads/file1"'
                ).to.equal(1)
                expect(entries[0].eventDetail.fileUrl, "invalid fileUrl").to.equal(mockServer.baseUrl + "/downloads/file1")
            }

            // /downloads/docRef -----------------------------------------------
            {
                const entries = logs.filter(e => e.eventId === "download_request" && e.eventDetail.fileUrl === mockServer.baseUrl + "/downloads/docRef")
                expect(
                    entries.length,
                    'download_request should be logged once for "/downloads/docRef"'
                ).to.equal(1)
                expect(entries[0].eventDetail.fileUrl, "invalid fileUrl").to.equal(mockServer.baseUrl + "/downloads/docRef")
                expect(entries[0].eventDetail.itemType).to.equal("output")
                expect(entries[0].eventDetail.resourceType).to.equal("DocumentReference")
            }

            {
                const entries = logs.filter(e => e.eventId === "download_complete" && e.eventDetail.fileUrl === mockServer.baseUrl + "/downloads/docRef")
                expect(
                    entries.length,
                    'download_complete should be logged once for "/downloads/docRef"'
                ).to.equal(1)
                expect(entries[0].eventDetail.fileUrl, "invalid fileUrl").to.equal(mockServer.baseUrl + "/downloads/docRef")
            }

            // /downloads/deleted ----------------------------------------------
            {
                const entries = logs.filter(e => e.eventId === "download_request" && e.eventDetail.fileUrl === mockServer.baseUrl + "/downloads/deleted")
                expect(
                    entries.length,
                    'download_request should be logged once for "/downloads/deleted"'
                ).to.equal(1)
                expect(entries[0].eventDetail.fileUrl, "invalid fileUrl").to.equal(mockServer.baseUrl + "/downloads/deleted")
                expect(entries[0].eventDetail.itemType).to.equal("deleted")
                expect(entries[0].eventDetail.resourceType).to.equal("Bundle")
            }

            {
                const entries = logs.filter(e => e.eventId === "download_complete" && e.eventDetail.fileUrl === mockServer.baseUrl + "/downloads/deleted")
                expect(
                    entries.length,
                    'download_complete should be logged once for "/downloads/deleted"'
                ).to.equal(1)
                expect(entries[0].eventDetail.fileUrl, "invalid fileUrl").to.equal(mockServer.baseUrl + "/downloads/deleted")
            }

            // /downloads/errors -----------------------------------------------
            {
                const entries = logs.filter(e => e.eventId === "download_request" && e.eventDetail.fileUrl === mockServer.baseUrl + "/downloads/errors")
                expect(
                    entries.length,
                    'download_request should be logged once for "/downloads/errors"'
                ).to.equal(1)
                expect(entries[0].eventDetail.fileUrl, "invalid fileUrl").to.equal(mockServer.baseUrl + "/downloads/errors")
                expect(entries[0].eventDetail.itemType).to.equal("error")
                expect(entries[0].eventDetail.resourceType).to.equal("OperationOutcome")
            }

            {
                const entries = logs.filter(e => e.eventId === "download_complete" && e.eventDetail.fileUrl === mockServer.baseUrl + "/downloads/errors")
                expect(
                    entries.length,
                    'download_complete should be logged once for "/downloads/errors"'
                ).to.equal(1)
                expect(entries[0].eventDetail.fileUrl, "invalid fileUrl").to.equal(mockServer.baseUrl + "/downloads/errors")
            }

            // /document.pdf ---------------------------------------------------
            {
                const entries = logs.filter(e => e.eventId === "download_request" && e.eventDetail.fileUrl === mockServer.baseUrl + "/document.pdf")
                expect(
                    entries.length,
                    'download_request should be logged once for "/document.pdf"'
                ).to.equal(1)
                expect(entries[0].eventDetail.fileUrl, "invalid fileUrl").to.equal(mockServer.baseUrl + "/document.pdf")
                expect(entries[0].eventDetail.itemType).to.equal("attachment")
                expect(entries[0].eventDetail.resourceType).to.equal(null)
            }

            {
                const entries = logs.filter(e => e.eventId === "download_complete" && e.eventDetail.fileUrl === mockServer.baseUrl + "/document.pdf")
                expect(
                    entries.length,
                    'download_complete should be logged once for "/document.pdf"'
                ).to.equal(1)
                expect(entries[0].eventDetail.fileUrl, "invalid fileUrl").to.equal(mockServer.baseUrl + "/document.pdf")
            }


            // export_complete -------------------------------------------------
            {
                const entries = logs.filter(e => e.eventId === "export_complete")
                expect(
                    entries.length,
                    'export_complete should be logged once'
                ).to.equal(1)
                expect(entries[0].eventDetail.files, "must report 4 files").to.equal(4)
                expect(entries[0].eventDetail.resources, "must report 5 resources").to.equal(5)
                expect(entries[0].eventDetail.attachments, "must report 1 attachment").to.equal(1)
                expect(entries[0].eventDetail.bytes, "must report some bytes").to.be.greaterThan(0)
                expect(entries[0].eventDetail.duration, "must report some duration").to.be.greaterThan(0)
            }
            
        })

        it ("logs download_error events on server errors", async () => {
            
            mockServer.mock("/metadata", { status: 200, body: {} });

            mockServer.mock("/Patient/\\$export", {
                status: 200,
                headers: {
                    "content-location": mockServer.baseUrl + "/status"
                }
            });

            mockServer.mock("/status", { status: 200, body: {
                transactionTime: new Date().toISOString(),
                output: [{
                    url : mockServer.baseUrl + "/downloads/file1.json",
                    type: "Patient"
                }],
                error: []
            }})

            const { log } = await invoke()
            const logs = log.split("\n").filter(Boolean).map(line => JSON.parse(line));
            // console.log(logs)
            const entry = logs.find(l => l.eventId === "download_error")
            expect(entry).to.exist()
            expect(entry.eventDetail.fileUrl).to.equal(mockServer.baseUrl + "/downloads/file1.json")
            expect(entry.eventDetail.body).to.equal(null)
            expect(entry.eventDetail.message).to.equal(
                `Downloading the file from ${mockServer.baseUrl}/downloads/file1.json returned HTTP status code 404.`
            )
        })

        it ("logs download_error events on invalid file contents", async () => {
            
            mockServer.mock("/metadata", { status: 200, body: {} });

            mockServer.mock("/Patient/\\$export", {
                status: 200,
                headers: {
                    "content-location": mockServer.baseUrl + "/status"
                }
            });

            mockServer.mock("/status", { status: 200, body: {
                transactionTime: new Date().toISOString(),
                output: [{
                    url : mockServer.baseUrl + "/downloads/file1",
                    type: "Patient"
                }],
                error: []
            }})

            mockServer.mock("/downloads/file1", { 
                handler(req, res) {
                    res.set("content-type", "application/fhir+ndjson")
                    res.set("Content-Disposition", "attachment")
                    res.end('{"resourceType":"Patient"}\n{"resourceType":"BadType"}')
                }
            })

            const { log } = await invoke()
            const logs = log.split("\n").filter(Boolean).map(line => JSON.parse(line));
            const entry = logs.find(l => l.eventId === "download_error")

            expect(entry).to.exist()
            expect(entry.eventDetail.fileUrl).to.equal(mockServer.baseUrl + "/downloads/file1")
            expect(entry.eventDetail.body).to.equal(null)
            expect(entry.eventDetail.message).to.equal(
                'Error parsing NDJSON on line 2: Error: Expected each resource ' + 
                'to have a "Patient" resourceType but found "BadType"'
            )
        })

        it ("logs download_error events on invalid resource count", async () => {
            
            mockServer.mock("/metadata", { status: 200, body: {} });

            mockServer.mock("/Patient/\\$export", {
                status: 200,
                headers: {
                    "content-location": mockServer.baseUrl + "/status"
                }
            });

            mockServer.mock("/status", { status: 200, body: {
                transactionTime: new Date().toISOString(),
                output: [{
                    url : mockServer.baseUrl + "/downloads/file1",
                    type: "Patient",
                    count: 30
                }],
                error: []
            }})

            mockServer.mock("/downloads/file1", { 
                handler(req, res) {
                    res.set("content-type", "application/fhir+ndjson")
                    res.set("Content-Disposition", "attachment")
                    res.end('{"resourceType":"Patient"}\n{"resourceType":"Patient"}')
                }
            })

            const { log } = await invoke()
            const logs = log.split("\n").filter(Boolean).map(line => JSON.parse(line));
            const entry = logs.find(l => l.eventId === "download_error")

            expect(entry).to.exist()
            expect(entry.eventDetail.fileUrl).to.equal(mockServer.baseUrl + "/downloads/file1")
            expect(entry.eventDetail.body).to.equal(null)
            expect(entry.eventDetail.message).to.equal('Expected 30 resources but found 2')
        })

        it ("logs download_error events on attachments", async () => {
            
            mockServer.mock("/metadata", { status: 200, body: {} });

            mockServer.mock("/Patient/\\$export", {
                status: 200,
                headers: {
                    "content-location": mockServer.baseUrl + "/status"
                }
            });

            mockServer.mock("/status", { status: 200, body: {
                transactionTime: new Date().toISOString(),
                output: [{
                    url : mockServer.baseUrl + "/downloads/file1",
                    type: "DocumentReference",
                    count: 1
                }],
                error: []
            }})

            mockServer.mock("/downloads/file1", {
                handler(req, res) {
                    res.set("content-type", "application/fhir+ndjson")
                    res.set("Content-Disposition", "attachment")
                    res.json({
                        "resourceType": "DocumentReference",
                        "content": [
                            {
                                "attachment": {
                                    "contentType": "application/pdf",
                                    "url": mockServer.baseUrl + "/document.pdf",
                                    "size": 1084656
                                }
                            }
                        ]
                    })
                }
            })

            mockServer.mock("/document.pdf", { status: 500 })

            const { log } = await invoke()
            const logs = log.split("\n").filter(Boolean).map(line => JSON.parse(line));
            // console.log(logs)
            const entry = logs.find(l => l.eventId === "download_error")

            expect(entry).to.exist()
            expect(entry.eventDetail.fileUrl).to.equal(mockServer.baseUrl + "/document.pdf")
            expect(entry.eventDetail.body).to.equal(null)
            expect(entry.eventDetail.message).to.equal(
                `Downloading the file from ${mockServer.baseUrl}/document.pdf returned HTTP status code 500.`
            )
        })  
    })
})
