# PLC Data Synchronization Utility

This program facilitates data sharing between Siemens S7-1200 PLCs. Siemens' built-in methods for PLC-to-PLC communication weren't flexible enough for my needs, so I developed this utility to overcome those limitations, particularly given the connection count constraints of the S7-1200 series. Your mileage may vary, but it has proven highly effective for my use cases.

The utility is designed to run continuously on a dedicated virtual machine (VM), Raspberry Pi or server and uses a **request-feedback model** to allow easy and flexible control over shared resources.

### Key Features

- **Data Retrieval & Synchronization**: The program collects data from multiple PLCs, combines it, and redistributes it, ensuring all PLCs have up-to-date information.
- **Request-Feedback Control**: Allows PLCs to request changes and verify their execution by other PLCs, promoting coordinated control without blocking unless specifically needed.
- **Fault Recovery**: Automatically recovers from PLC reboots and network errors.
- **HTTP JSON Interface**: Exposes a troubleshooting interface with read/write counters and status for each PLC.
- **Config File for Easy Setup**: Add and remove PLCs and shared data simply by editing the configuration file.
- **Log Files with Rotation**: Detailed logs with automated rotation for easy maintenance.
- **Online Manual**: Provides usage instructions, accessible from the running server.

### Request-Feedback Control Explained
The program uses a **request-feedback** model to manage control across PLCs. Here is an example:
- **PLC A** requests a pump to be turned on, sharing the request and setting its (shared) acknowledgment (ack) flag to `false`.
- **PLC B** reads the request, sees the ack is `false`, executes the command(switches the pump on), and shares the resulting state of the pump.
- **PLC A** verifies that its request has been executed based on PLC B's shared state and then sets its ack to `true`.

This approach allows multiple PLCs to interact with shared devices, like pumps, without blocking each other—unless desired, in which case you can adjust the logic accordingly.

### Heartbeat Mechanism
The utility also uses **heartbeat signals** to ensure data integrity and device status:
- **Server Heartbeat**: The server provides a heartbeat, letting PLCs verify that the shared data is up-to-date.
- **PLC Heartbeat**: Each PLC produces its own heartbeat, shared along with other data, so other PLCs can verify if it is active.

### Installation & Usage
This program is currently implemented in **Node.js**. The configuration is straightforward, and the setup primarily involves specifying PLC IPs, rack/slot numbers, and data block configurations in a JSON file.

An experimental **Rust version** of the program is also under development for those seeking more performance or different runtime characteristics.

### Important Considerations
- **Security**: No security measures are currently implemented in this program. Please keep this in mind when deploying.
- **PLC Configuration**: Ensure that the PLCs have **optimized block access disabled** and that **PUT/GET** is allowed for proper operation.

### Planned Improvements
- Development of a **Rust version** for improved efficiency and portability.
- Potential addition of **basic security features** to help secure data communication.

Feel free to contribute, submit issues, or suggest features. Together we can make this utility more robust and extend its capabilities for the broader Siemens PLC community.

### Disclaimer
This software is provided "as-is" without any guarantees. Use it at your own risk and ensure that it fits your particular use case and safety requirements.

