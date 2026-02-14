"""Zajel headless client daemon.

Starts the ZajelHeadlessClient, opens a UNIX domain socket, and
dispatches CLI commands to the client. Each connection reads JSON-line
requests and writes JSON-line responses.

Usage:
    zajel-daemon --signaling-url wss://signal.example.com/ws --name bob
"""

import argparse
import asyncio
import json
import logging
import os
import signal
import sys
import uuid

from ..client import ZajelHeadlessClient
from .protocol import async_readline, async_send, default_socket_path, serialize_result
from . import serializers

logger = logging.getLogger("zajel.cli.daemon")


async def handle_connection(
    reader: asyncio.StreamReader,
    writer: asyncio.StreamWriter,
    client: ZajelHeadlessClient,
    dispatch: dict,
    shutdown_event: asyncio.Event,
):
    """Handle a single CLI connection."""
    peer = writer.get_extra_info("peername") or "unknown"
    logger.debug("CLI connection from %s", peer)
    try:
        while True:
            line = await async_readline(reader)
            if line is None:
                break

            try:
                request = json.loads(line)
            except json.JSONDecodeError as e:
                await async_send(writer, {"error": f"Invalid JSON: {e}"})
                continue

            req_id = request.get("id", str(uuid.uuid4()))
            cmd = request.get("cmd", "")
            args = request.get("args", {})

            if cmd not in dispatch:
                await async_send(writer, {
                    "id": req_id,
                    "error": f"Unknown command: {cmd}",
                })
                continue

            try:
                handler = dispatch[cmd]
                result = await handler(client, args)
                await async_send(writer, {
                    "id": req_id,
                    "result": serialize_result(result),
                })
            except Exception as e:
                logger.error("Command %s failed: %s", cmd, e, exc_info=True)
                await async_send(writer, {
                    "id": req_id,
                    "error": str(e),
                })

            # Check if we should shut down
            if cmd == "disconnect":
                shutdown_event.set()
                break
    except asyncio.CancelledError:
        pass
    except Exception as e:
        logger.error("Connection error: %s", e)
    finally:
        writer.close()
        try:
            await writer.wait_closed()
        except Exception:
            pass
        logger.debug("CLI connection closed")


# ── Command handlers ────────────────────────────────────────────


async def cmd_status(client: ZajelHeadlessClient, args: dict):
    peers = client.get_connected_peers()
    return {
        "pairing_code": client.pairing_code,
        "name": client.name,
        "connected_peers": [
            serializers.serialize_connected_peer(p) for p in peers.values()
        ],
    }


async def cmd_pair_with(client: ZajelHeadlessClient, args: dict):
    code = args["code"]
    peer = await client.pair_with(code)
    return serializers.serialize_connected_peer(peer)


async def cmd_wait_for_pair(client: ZajelHeadlessClient, args: dict):
    timeout = args.get("timeout", 60)
    peer = await client.wait_for_pair(timeout=timeout)
    return serializers.serialize_connected_peer(peer)


async def cmd_send_text(client: ZajelHeadlessClient, args: dict):
    await client.send_text(args["peer_id"], args["content"])
    return {"ok": True}


async def cmd_receive_message(client: ZajelHeadlessClient, args: dict):
    timeout = args.get("timeout", 30)
    msg = await client.receive_message(timeout=timeout)
    return serializers.serialize_received_message(msg)


async def cmd_create_channel(client: ZajelHeadlessClient, args: dict):
    channel = await client.create_channel(
        name=args["name"],
        description=args.get("description", ""),
    )
    return serializers.serialize_owned_channel(channel)


async def cmd_get_channel_invite_link(client: ZajelHeadlessClient, args: dict):
    link = client.get_channel_invite_link(args["channel_id"])
    return {"invite_link": link}


async def cmd_publish_channel_message(client: ZajelHeadlessClient, args: dict):
    chunks = await client.publish_channel_message(
        args["channel_id"], args["text"]
    )
    return {"chunks_published": len(chunks)}


async def cmd_subscribe_channel(client: ZajelHeadlessClient, args: dict):
    channel = await client.subscribe_channel(args["invite_link"])
    return serializers.serialize_subscribed_channel(channel)


async def cmd_get_subscribed_channels(client: ZajelHeadlessClient, args: dict):
    channels = await client.get_subscribed_channels()
    return [serializers.serialize_subscribed_channel(c) for c in channels]


async def cmd_unsubscribe_channel(client: ZajelHeadlessClient, args: dict):
    await client.unsubscribe_channel(args["channel_id"])
    return {"ok": True}


async def cmd_receive_channel_content(client: ZajelHeadlessClient, args: dict):
    timeout = args.get("timeout", 30)
    channel_id, payload = await client.receive_channel_content(timeout=timeout)
    return serializers.serialize_channel_content(channel_id, payload)


async def cmd_create_group(client: ZajelHeadlessClient, args: dict):
    group = await client.create_group(name=args["name"])
    return serializers.serialize_group(group)


async def cmd_get_groups(client: ZajelHeadlessClient, args: dict):
    groups = await client.get_groups()
    return [serializers.serialize_group(g) for g in groups]


async def cmd_send_group_message(client: ZajelHeadlessClient, args: dict):
    msg = await client.send_group_message(args["group_id"], args["content"])
    return serializers.serialize_group_message(msg)


async def cmd_wait_for_group_message(client: ZajelHeadlessClient, args: dict):
    timeout = args.get("timeout", 30)
    msg = await client.wait_for_group_message(timeout=timeout)
    return serializers.serialize_group_message(msg)


async def cmd_wait_for_group_invitation(client: ZajelHeadlessClient, args: dict):
    timeout = args.get("timeout", 30)
    group = await client.wait_for_group_invitation(timeout=timeout)
    return serializers.serialize_group(group)


async def cmd_leave_group(client: ZajelHeadlessClient, args: dict):
    await client.leave_group(args["group_id"])
    return {"ok": True}


async def cmd_send_file(client: ZajelHeadlessClient, args: dict):
    file_id = await client.send_file(args["peer_id"], args["file_path"])
    return {"file_id": file_id}


async def cmd_receive_file(client: ZajelHeadlessClient, args: dict):
    timeout = args.get("timeout", 60)
    progress = await client.receive_file(timeout=timeout)
    return serializers.serialize_file_transfer(progress)


async def cmd_get_peers(client: ZajelHeadlessClient, args: dict):
    peers = client.get_connected_peers()
    return [serializers.serialize_connected_peer(p) for p in peers.values()]


async def cmd_get_trusted_peers(client: ZajelHeadlessClient, args: dict):
    peers = await client.get_trusted_peers()
    return [serializers.serialize_stored_peer(p) for p in peers]


async def cmd_block_peer(client: ZajelHeadlessClient, args: dict):
    await client.block_peer(args["peer_id"])
    return {"ok": True}


async def cmd_unblock_peer(client: ZajelHeadlessClient, args: dict):
    await client.unblock_peer(args["peer_id"])
    return {"ok": True}


async def cmd_disconnect(client: ZajelHeadlessClient, args: dict):
    await client.disconnect()
    return {"ok": True}


COMMANDS = {
    "status": cmd_status,
    "pair_with": cmd_pair_with,
    "wait_for_pair": cmd_wait_for_pair,
    "send_text": cmd_send_text,
    "receive_message": cmd_receive_message,
    "create_channel": cmd_create_channel,
    "get_channel_invite_link": cmd_get_channel_invite_link,
    "publish_channel_message": cmd_publish_channel_message,
    "subscribe_channel": cmd_subscribe_channel,
    "get_subscribed_channels": cmd_get_subscribed_channels,
    "unsubscribe_channel": cmd_unsubscribe_channel,
    "receive_channel_content": cmd_receive_channel_content,
    "create_group": cmd_create_group,
    "get_groups": cmd_get_groups,
    "send_group_message": cmd_send_group_message,
    "wait_for_group_message": cmd_wait_for_group_message,
    "wait_for_group_invitation": cmd_wait_for_group_invitation,
    "leave_group": cmd_leave_group,
    "send_file": cmd_send_file,
    "receive_file": cmd_receive_file,
    "get_peers": cmd_get_peers,
    "get_trusted_peers": cmd_get_trusted_peers,
    "block_peer": cmd_block_peer,
    "unblock_peer": cmd_unblock_peer,
    "disconnect": cmd_disconnect,
}


async def run_daemon(args: argparse.Namespace) -> None:
    """Main daemon entry point."""
    ice_servers = None
    if args.ice_servers:
        ice_servers = json.loads(args.ice_servers)

    client = ZajelHeadlessClient(
        signaling_url=args.signaling_url,
        name=args.name,
        auto_accept_pairs=args.auto_accept,
        log_level=args.log_level,
        ice_servers=ice_servers,
    )

    pairing_code = await client.connect()

    socket_path = args.socket_path or default_socket_path(args.name)

    # Clean up stale socket file
    if os.path.exists(socket_path):
        os.unlink(socket_path)

    shutdown_event = asyncio.Event()

    async def on_connection(reader, writer):
        await handle_connection(reader, writer, client, COMMANDS, shutdown_event)

    server = await asyncio.start_unix_server(on_connection, path=socket_path)

    # Print pairing code to stdout for CI to capture
    print(json.dumps({"pairing_code": pairing_code, "socket": socket_path}), flush=True)
    logger.info("Daemon listening on %s (pairing code: %s)", socket_path, pairing_code)

    # Handle SIGTERM/SIGINT gracefully
    loop = asyncio.get_running_loop()
    for sig in (signal.SIGTERM, signal.SIGINT):
        loop.add_signal_handler(sig, shutdown_event.set)

    # Wait for shutdown
    await shutdown_event.wait()

    logger.info("Shutting down daemon...")
    server.close()
    await server.wait_closed()

    # Clean up socket file
    if os.path.exists(socket_path):
        os.unlink(socket_path)

    await client.disconnect()
    logger.info("Daemon stopped")


def parse_args(argv: list[str] | None = None) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        prog="zajel-daemon",
        description="Zajel headless client daemon",
    )
    parser.add_argument(
        "--signaling-url",
        required=True,
        help="WebSocket URL of the signaling server",
    )
    parser.add_argument(
        "--name",
        default="headless",
        help="Display name for this client (default: headless)",
    )
    parser.add_argument(
        "--socket-path",
        default=None,
        help="UNIX socket path (default: /tmp/zajel-headless-<name>.sock)",
    )
    parser.add_argument(
        "--auto-accept",
        action="store_true",
        help="Auto-accept incoming pair requests",
    )
    parser.add_argument(
        "--log-level",
        default="INFO",
        choices=["DEBUG", "INFO", "WARNING", "ERROR"],
        help="Logging level (default: INFO)",
    )
    parser.add_argument(
        "--ice-servers",
        default=None,
        help="ICE servers as a JSON array string",
    )
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> None:
    args = parse_args(argv)
    asyncio.run(run_daemon(args))


if __name__ == "__main__":
    main()
