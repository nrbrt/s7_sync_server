# PLC Sync Server Manual

## Introduction

This program is designed to facilitate data sharing between Siemens S7-1200 PLCs. The default Siemens method for sharing data between PLCs can be inflexible, especially when dealing with multiple PLCs. This solution offers a flexible approach, allowing multiple PLCs to share and synchronize data via an intermediary server. The server program is currently implemented in Node.js and can be run on a virtual machine or any compatible environment.

Key features include:
- Data retrieval and synchronization between PLCs.
- HTTP JSON interface for troubleshooting, providing read/write counters.
- Configurable via a JSON configuration file.
- Log files with rotation for monitoring events.
- An online manual available through the web interface.

## Requirements

- Node.js (v12 or higher recommended)
- PLCs with PUT/GET communication enabled
- Optimized block access disabled for Data Blocks that need to be shared

## Installation

1. Clone the repository or copy the files to your desired location.
2. Install the required Node.js modules by running:
   ```sh
   npm install
   ```
3. Make sure to edit the `config.json` to match your PLC setup.
4. Start the program using:
   ```sh
   node index.js
   ```

Alternatively, you can use PM2 to run the program in the background and ensure it starts automatically on boot:

1. Install PM2 globally:
   ```sh
   npm install -g pm2
   ```
2. Start the program with PM2:
   ```sh
   pm2 start index.js --name plc-sync-server
   ```
3. To ensure PM2 restarts on server reboot:
   ```sh
   pm2 save
   pm2 startup
   ```

## Configuration

The configuration file (`config.json`) defines the PLCs, shared data, and server settings. Here is an example configuration:

```json
{
  "operationInterval": 2000,
  "maxReconnectAttempts": 10,
  "reconnectInterval": 5000,
  "heartbeatOffset": 46,
  "httpPort": 3010,
  "syncDbNumber": 200,
  "apiConfig": {
    "baseUrl": "http://localhost",
    "dataEndpoint": "/data",
    "manualEndpoint": "/manual"
  },
  "plcs": [
    {
      "name": "PLC_SERVER",
      "ip": "192.168.178.190",
      "rack": 0,
      "slot": 1,
      "syncDbOffset": 0,
      "dbNumber": 17,
      "variables": {
        "cip_pump_enable_state": { "type": "INT", "offset": 0 },
        "buffer1_temperature": { "type": "REAL", "offset": 2 },
        "buffer2_temperature": { "type": "REAL", "offset": 6 }
      }
    },
    {
      "name": "PLC_H150",
      "ip": "192.168.178.184",
      "rack": 0,
      "slot": 1,
      "syncDbOffset": 50,
      "dbNumber": 17,
      "variables": {
        "cip_pump_speed_state": { "type": "INT", "offset": 0 },
        "heartbeat": { "type": "INT", "offset": 2 }
      }
    }
  ]
}
```

### Explanation of Configuration

- **operationInterval**: Interval (in milliseconds) at which data synchronization occurs.
- **maxReconnectAttempts**: Number of attempts to reconnect to a PLC after a connection failure.
- **reconnectInterval**: Interval (in milliseconds) between reconnection attempts.
- **heartbeatOffset**: The offset in the data block for the server's heartbeat value. This is now automatically calculated based on the other variables defined.
- **httpPort**: Port number for the HTTP server.
- **syncDbNumber**: Default Data Block number used for synchronization. Individual PLCs can override this value.
- **apiConfig**: Contains configuration for the HTTP API.
  - **baseUrl**: Base URL of the API.
  - **dataEndpoint**: Endpoint for accessing combined PLC data.
  - **manualEndpoint**: Endpoint for accessing the manual.
- **plcs**: Array of PLC configurations.
  - **name**: A unique identifier for the PLC.
  - **ip**: IP address of the PLC.
  - **rack**: Rack number for the PLC.
  - **slot**: Slot number for the PLC.
  - **syncDbOffset**: Offset within the synchronization Data Block for this PLC's data.
  - **dbNumber**: Data Block number to be read from/written to.
  - **variables**: Defines the variables to be read or written.
    - **type**: Data type of the variable (`INT`, `REAL`, `BOOL`).
    - **offset**: Byte offset of the variable within the Data Block.

### Example Variable Definitions

The configuration allows different types of variables to be defined, such as:

- **Integer** (`INT`):
  ```json
  "variable_name": { "type": "INT", "offset": 0 }
  ```
- **Boolean** (`BOOL`):
  ```json
  "variable_name": { "type": "BOOL", "byte": 2, "bit": 3 }
  ```
- **Real Number** (`REAL`):
  ```json
  "variable_name": { "type": "REAL", "offset": 4 }
  ```

## Data Synchronization and Server Heartbeat

The server combines data from all configured PLCs and synchronizes it back. A server heartbeat is included in the data, allowing PLCs to verify the freshness of the data they receive. The offset for this heartbeat is now calculated automatically to ensure it comes after all other variables in the sync data block.

The synchronization mechanism ensures that all PLCs receive updated data, including any commands or status changes requested by other PLCs.

## HTTP API

The server provides a simple HTTP API for monitoring purposes:

- **Data Endpoint** (`/data`): Returns JSON with the following information:
  - `serverHeartbeat`: Heartbeat value to check if the server is running.
  - `combinedData`: All synchronized data from the PLCs.
  - `counters`: Read and write counters for each PLC.
  - `manualURL`: URL for accessing the manual.

- **Manual Endpoint** (`/manual`): Returns the HTML manual.

To access the API, use the following URLs:
- Data: `${baseUrl}:${httpPort}${dataEndpoint}`
- Manual: `${baseUrl}:${httpPort}${manualEndpoint}`

## Logging

Logs are created daily and rotated automatically. The following types of logs are available:
- **Info Logs**: General information, including successful connections and data synchronization events.
- **Error Logs**: Errors that occur during PLC communication or server operations.

## Adding or Removing PLCs

To add or remove a PLC, update the `config.json` file and restart the server. The program will automatically establish connections to the newly added PLCs and integrate them into the data synchronization process.

## Running in Production

For production environments, it's recommended to use PM2 to manage the process. This ensures the server will automatically restart in case of an error or system reboot.

## Security Considerations

No security measures are implemented in this program. Ensure that appropriate security measures are taken when deploying in a production environment, such as network isolation or VPNs.

## Troubleshooting

- **Connection Issues**: If the server cannot connect to a PLC, check the IP address, rack, and slot configuration in `config.json`. Also, ensure the PLC allows PUT/GET communication.
- **Data Not Syncing**: Verify that the Data Blocks in the PLC have optimized block access disabled.
- **Heartbeat Issues**: Ensure the heartbeat value is being updated correctly by the server and that each PLC is reading the heartbeat to confirm the data is fresh.

## Contact

For more information, refer to the online manual or open an issue on the GitHub repository.
