This program is to make it easier sharing data between S7 1200 PLC's. That is what I use it for anyway. The way Siemens does the sharing of data between PLCs is not flexible enough for me. Your milage may vary. The S7 1200 series has a limitation of connection count as well. I use an extra VM that runs this program 24/7. I control things using a request-feedback model. The program provides data retrieval, data synchronisation, a http json interface for troubleshooting, a config file, log files that get rotated and an online manual.

It is easy to add and remove PLCs and shared data using the config file.

It will recover from PLCs rebooting and network errors. The data that is shared by each plc is combined and that combined data is distributed to all PLCs.

I provide a server heartbeat, so the PLC's know the data a fresh and I have my PLCs produce a heartbeat as well that is in their shared data. That way the PLCs can check if the other PLC is alive. I use a request-feedback model. So PLC A request a pump to be on and shares that request. PLC B reads that request and shares the current state of the pump. PLC A can see that the request was executed in the synced data from PLC B.

At the moment it is a node.js application, but I am working on a Rust version as well.

ATTENTION: no security measures are implemented. The datablocks need to have optimized block access disabled and the PLCs need to allow PUT/GET!
