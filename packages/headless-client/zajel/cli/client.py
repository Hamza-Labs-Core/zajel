"""Zajel CLI client — sends commands to the running daemon.

Usage:
    zajel-cli [--socket /tmp/zajel-headless-default.sock] <command> [args...]

Output is JSON by default (machine-readable for CI).
Use --pretty for indented, human-readable output.
"""

import argparse
import json
import socket
import sys
import uuid

from .protocol import default_socket_path, send_request, read_response


def connect_to_daemon(socket_path: str) -> socket.socket:
    """Connect to the daemon's UNIX socket."""
    sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        sock.connect(socket_path)
    except FileNotFoundError:
        print(
            json.dumps({"error": f"Daemon socket not found: {socket_path}"}),
            file=sys.stderr,
        )
        sys.exit(1)
    except ConnectionRefusedError:
        print(
            json.dumps({"error": f"Daemon not responding on: {socket_path}"}),
            file=sys.stderr,
        )
        sys.exit(1)
    return sock


def execute_command(socket_path: str, cmd: str, args: dict, pretty: bool = False) -> int:
    """Send a command to the daemon and print the response.

    Returns 0 on success, 1 on error.
    """
    sock = connect_to_daemon(socket_path)
    try:
        req_id = str(uuid.uuid4())
        send_request(sock, {"id": req_id, "cmd": cmd, "args": args})
        response, _ = read_response(sock)
    finally:
        sock.close()

    if "error" in response:
        indent = 2 if pretty else None
        print(json.dumps({"error": response["error"]}, indent=indent), file=sys.stderr)
        return 1

    result = response.get("result")
    indent = 2 if pretty else None
    print(json.dumps(result, indent=indent, default=str))
    return 0


# ── Subcommand handlers ────────────────────────────────────────


def cmd_status(args: argparse.Namespace) -> int:
    return execute_command(args.socket, "status", {}, args.pretty)


def cmd_pair_with(args: argparse.Namespace) -> int:
    return execute_command(args.socket, "pair_with", {"code": args.code}, args.pretty)


def cmd_wait_for_pair(args: argparse.Namespace) -> int:
    return execute_command(
        args.socket, "wait_for_pair", {"timeout": args.timeout}, args.pretty
    )


def cmd_send_text(args: argparse.Namespace) -> int:
    return execute_command(
        args.socket,
        "send_text",
        {"peer_id": args.peer_id, "content": args.content},
        args.pretty,
    )


def cmd_receive_message(args: argparse.Namespace) -> int:
    return execute_command(
        args.socket, "receive_message", {"timeout": args.timeout}, args.pretty
    )


def cmd_create_channel(args: argparse.Namespace) -> int:
    return execute_command(
        args.socket,
        "create_channel",
        {"name": args.name, "description": args.description or ""},
        args.pretty,
    )


def cmd_get_channel_invite_link(args: argparse.Namespace) -> int:
    return execute_command(
        args.socket,
        "get_channel_invite_link",
        {"channel_id": args.channel_id},
        args.pretty,
    )


def cmd_publish_channel_message(args: argparse.Namespace) -> int:
    return execute_command(
        args.socket,
        "publish_channel_message",
        {"channel_id": args.channel_id, "text": args.text},
        args.pretty,
    )


def cmd_subscribe_channel(args: argparse.Namespace) -> int:
    return execute_command(
        args.socket,
        "subscribe_channel",
        {"invite_link": args.invite_link},
        args.pretty,
    )


def cmd_get_subscribed_channels(args: argparse.Namespace) -> int:
    return execute_command(
        args.socket, "get_subscribed_channels", {}, args.pretty
    )


def cmd_unsubscribe_channel(args: argparse.Namespace) -> int:
    return execute_command(
        args.socket,
        "unsubscribe_channel",
        {"channel_id": args.channel_id},
        args.pretty,
    )


def cmd_receive_channel_content(args: argparse.Namespace) -> int:
    return execute_command(
        args.socket,
        "receive_channel_content",
        {"timeout": args.timeout},
        args.pretty,
    )


def cmd_create_group(args: argparse.Namespace) -> int:
    return execute_command(
        args.socket, "create_group", {"name": args.name}, args.pretty
    )


def cmd_get_groups(args: argparse.Namespace) -> int:
    return execute_command(args.socket, "get_groups", {}, args.pretty)


def cmd_send_group_message(args: argparse.Namespace) -> int:
    return execute_command(
        args.socket,
        "send_group_message",
        {"group_id": args.group_id, "content": args.content},
        args.pretty,
    )


def cmd_wait_for_group_message(args: argparse.Namespace) -> int:
    return execute_command(
        args.socket,
        "wait_for_group_message",
        {"timeout": args.timeout},
        args.pretty,
    )


def cmd_wait_for_group_invitation(args: argparse.Namespace) -> int:
    return execute_command(
        args.socket,
        "wait_for_group_invitation",
        {"timeout": args.timeout},
        args.pretty,
    )


def cmd_leave_group(args: argparse.Namespace) -> int:
    return execute_command(
        args.socket, "leave_group", {"group_id": args.group_id}, args.pretty
    )


def cmd_send_file(args: argparse.Namespace) -> int:
    return execute_command(
        args.socket,
        "send_file",
        {"peer_id": args.peer_id, "file_path": args.file_path},
        args.pretty,
    )


def cmd_receive_file(args: argparse.Namespace) -> int:
    return execute_command(
        args.socket, "receive_file", {"timeout": args.timeout}, args.pretty
    )


def cmd_get_peers(args: argparse.Namespace) -> int:
    return execute_command(args.socket, "get_peers", {}, args.pretty)


def cmd_get_trusted_peers(args: argparse.Namespace) -> int:
    return execute_command(args.socket, "get_trusted_peers", {}, args.pretty)


def cmd_block_peer(args: argparse.Namespace) -> int:
    return execute_command(
        args.socket, "block_peer", {"peer_id": args.peer_id}, args.pretty
    )


def cmd_unblock_peer(args: argparse.Namespace) -> int:
    return execute_command(
        args.socket, "unblock_peer", {"peer_id": args.peer_id}, args.pretty
    )


def cmd_disconnect(args: argparse.Namespace) -> int:
    return execute_command(args.socket, "disconnect", {}, args.pretty)


def build_parser() -> argparse.ArgumentParser:
    parser = argparse.ArgumentParser(
        prog="zajel-cli",
        description="Zajel headless client CLI",
    )
    parser.add_argument(
        "--socket",
        default=default_socket_path("default"),
        help="UNIX socket path (default: /tmp/zajel-headless-default.sock)",
    )
    parser.add_argument(
        "--pretty",
        action="store_true",
        help="Pretty-print JSON output",
    )

    sub = parser.add_subparsers(dest="command", required=True)

    # status
    p = sub.add_parser("status", help="Get daemon status and pairing code")
    p.set_defaults(func=cmd_status)

    # pair-with
    p = sub.add_parser("pair-with", help="Pair with a peer by code")
    p.add_argument("code", help="Peer's pairing code")
    p.set_defaults(func=cmd_pair_with)

    # wait-for-pair
    p = sub.add_parser("wait-for-pair", help="Wait for incoming pair request")
    p.add_argument("--timeout", type=float, default=60, help="Timeout in seconds")
    p.set_defaults(func=cmd_wait_for_pair)

    # send-text
    p = sub.add_parser("send-text", help="Send a text message to a peer")
    p.add_argument("--peer-id", required=True, help="Peer ID")
    p.add_argument("content", help="Message text")
    p.set_defaults(func=cmd_send_text)

    # receive-message
    p = sub.add_parser("receive-message", help="Wait for a text message")
    p.add_argument("--timeout", type=float, default=30, help="Timeout in seconds")
    p.set_defaults(func=cmd_receive_message)

    # create-channel
    p = sub.add_parser("create-channel", help="Create a new channel")
    p.add_argument("name", help="Channel name")
    p.add_argument("--description", default="", help="Channel description")
    p.set_defaults(func=cmd_create_channel)

    # get-channel-invite-link
    p = sub.add_parser("get-channel-invite-link", help="Get invite link for a channel")
    p.add_argument("channel_id", help="Channel ID")
    p.set_defaults(func=cmd_get_channel_invite_link)

    # publish-channel-message
    p = sub.add_parser("publish-channel-message", help="Publish message to channel")
    p.add_argument("channel_id", help="Channel ID")
    p.add_argument("text", help="Message text")
    p.set_defaults(func=cmd_publish_channel_message)

    # subscribe-channel
    p = sub.add_parser("subscribe-channel", help="Subscribe to a channel via invite link")
    p.add_argument("invite_link", help="zajel://channel/... invite link")
    p.set_defaults(func=cmd_subscribe_channel)

    # get-subscribed-channels
    p = sub.add_parser("get-subscribed-channels", help="List subscribed channels")
    p.set_defaults(func=cmd_get_subscribed_channels)

    # unsubscribe-channel
    p = sub.add_parser("unsubscribe-channel", help="Unsubscribe from a channel")
    p.add_argument("channel_id", help="Channel ID")
    p.set_defaults(func=cmd_unsubscribe_channel)

    # receive-channel-content
    p = sub.add_parser("receive-channel-content", help="Wait for channel content")
    p.add_argument("--timeout", type=float, default=30, help="Timeout in seconds")
    p.set_defaults(func=cmd_receive_channel_content)

    # create-group
    p = sub.add_parser("create-group", help="Create a new group")
    p.add_argument("name", help="Group name")
    p.set_defaults(func=cmd_create_group)

    # get-groups
    p = sub.add_parser("get-groups", help="List all groups")
    p.set_defaults(func=cmd_get_groups)

    # send-group-message
    p = sub.add_parser("send-group-message", help="Send message to a group")
    p.add_argument("group_id", help="Group ID")
    p.add_argument("content", help="Message text")
    p.set_defaults(func=cmd_send_group_message)

    # wait-for-group-message
    p = sub.add_parser("wait-for-group-message", help="Wait for a group message")
    p.add_argument("--timeout", type=float, default=30, help="Timeout in seconds")
    p.set_defaults(func=cmd_wait_for_group_message)

    # wait-for-group-invitation
    p = sub.add_parser("wait-for-group-invitation", help="Wait for group invitation")
    p.add_argument("--timeout", type=float, default=30, help="Timeout in seconds")
    p.set_defaults(func=cmd_wait_for_group_invitation)

    # leave-group
    p = sub.add_parser("leave-group", help="Leave a group")
    p.add_argument("group_id", help="Group ID")
    p.set_defaults(func=cmd_leave_group)

    # send-file
    p = sub.add_parser("send-file", help="Send a file to a peer")
    p.add_argument("--peer-id", required=True, help="Peer ID")
    p.add_argument("file_path", help="Path to file")
    p.set_defaults(func=cmd_send_file)

    # receive-file
    p = sub.add_parser("receive-file", help="Wait for a file transfer")
    p.add_argument("--timeout", type=float, default=60, help="Timeout in seconds")
    p.set_defaults(func=cmd_receive_file)

    # get-peers
    p = sub.add_parser("get-peers", help="List connected peers")
    p.set_defaults(func=cmd_get_peers)

    # get-trusted-peers
    p = sub.add_parser("get-trusted-peers", help="List trusted peers from storage")
    p.set_defaults(func=cmd_get_trusted_peers)

    # block-peer
    p = sub.add_parser("block-peer", help="Block a peer")
    p.add_argument("peer_id", help="Peer ID")
    p.set_defaults(func=cmd_block_peer)

    # unblock-peer
    p = sub.add_parser("unblock-peer", help="Unblock a peer")
    p.add_argument("peer_id", help="Peer ID")
    p.set_defaults(func=cmd_unblock_peer)

    # disconnect
    p = sub.add_parser("disconnect", help="Disconnect and shut down daemon")
    p.set_defaults(func=cmd_disconnect)

    return parser


def main(argv: list[str] | None = None) -> None:
    parser = build_parser()
    args = parser.parse_args(argv)
    exit_code = args.func(args)
    sys.exit(exit_code)


if __name__ == "__main__":
    main()
