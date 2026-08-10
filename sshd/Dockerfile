# Stock OpenSSH server for Phase 0 verification.
#
# Deliberately vanilla: no agent, no patches, no weirdvault-specific config. The
# whole point of the spike is proving we authenticate against an unmodified
# sshd exactly as a normal SSH client would.
FROM alpine:3

RUN apk add --no-cache openssh-server bash coreutils

RUN ssh-keygen -A

# Unprivileged test user. Password is set so we can also exercise the
# password-auth onboarding path (connect once with a password, let weirdvault
# install the key itself).
RUN adduser -D -s /bin/bash weirdvault \
 && echo 'weirdvault:weirdvault' | chpasswd \
 && mkdir -p /home/weirdvault/.ssh \
 && touch /home/weirdvault/.ssh/authorized_keys \
 && chown -R weirdvault:weirdvault /home/weirdvault/.ssh \
 && chmod 700 /home/weirdvault/.ssh \
 && chmod 600 /home/weirdvault/.ssh/authorized_keys

RUN printf '%s\n' \
    'PermitRootLogin no' \
    'PubkeyAuthentication yes' \
    'PasswordAuthentication yes' \
    'AuthorizedKeysFile .ssh/authorized_keys' \
    'LogLevel VERBOSE' \
    > /etc/ssh/sshd_config.d/weirdvault.conf

EXPOSE 22
CMD ["/usr/sbin/sshd", "-D", "-e"]
