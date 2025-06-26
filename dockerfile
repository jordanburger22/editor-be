FROM cirrusci/flutter:stable

# Accept UID/GID as build arguments
ARG UID=1000
ARG GID=1000

# Create a non-root user and group
RUN groupadd -g $GID flutteruser && useradd -m -u $UID -g flutteruser flutteruser

# Change ownership of the Flutter SDK
RUN chown -R flutteruser:flutteruser /sdks/flutter || chown -R flutteruser:flutteruser /flutter

# Switch to non-root user
USER flutteruser

# Mark the Flutter SDK directory as safe for git
RUN git config --global --add safe.directory /sdks/flutter
RUN git config --global --add safe.directory /flutter

WORKDIR /app

CMD ["flutter", "build", "web", "--release", "--verbose"]