pipeline {
    agent any

    options {
        timestamps()
        disableConcurrentBuilds()
    }

    stages {
        stage('Validate Project Structure') {
            steps {
                sh '''
                    set -eu
                    test -f docker-compose.yml
                    test -f gateway/package.json
                    test -f limiter-service/package.json
                    test -f backend-mock/package.json
                    echo "Project structure looks correct."
                '''
            }
        }

        stage('Install Dependencies') {
            steps {
                sh '''
                    set -eu
                    for service in gateway limiter-service backend-mock; do
                        echo "Installing dependencies for $service"
                        (cd "$service" && npm ci)
                    done
                '''
            }
        }

        stage('Syntax Check') {
            steps {
                sh '''
                    set -eu
                    node --check gateway/server.js
                    node --check limiter-service/server.js
                    node --check backend-mock/server.js
                    echo "Node.js syntax checks passed."
                '''
            }
        }

        stage('Validate Docker Compose') {
            steps {
                sh 'docker compose config --quiet'
            }
        }

        stage('Build Docker Images') {
            steps {
                sh 'docker compose build'
            }
        }
    }

    post {
        success {
            echo 'CI pipeline completed successfully.'
        }
        failure {
            echo 'CI pipeline failed. Check the stage logs above.'
        }
        always {
            echo 'Pipeline finished.'
        }
    }
}
